import { createHash } from "node:crypto";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken } from "firebase/auth";
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { connectStorageEmulator, getBytes, getStorage, ref, uploadBytes, type FirebaseStorage } from "firebase/storage";
import type { RunnerConfig } from "./config.js";
import type { RepoWarning } from "./git.js";
import type { Quota } from "./quota.js";

export type FeatureStatus = "backlog" | "rejected" | "execute" | "running" | "done" | "failed" | "waiting";

export interface Feature {
  title: string;
  refinedPrompt: string;
  acceptanceCriteria?: string[];
  status: FeatureStatus;
  assignee?: string;
  branch?: string;
  promptHash?: string;
  attempts?: number;
  /** Imágenes y documentos que adjuntó quien propuso la tarea. */
  attachments?: Attachment[];
  /** Sesión de Claude de esta tarea: si existe, el runner la continúa en lugar de empezar de cero. */
  sessionId?: string;
  /** Modelo elegido en la app ("auto" = el que sugirió el refinador) y la sugerencia. */
  model?: "auto" | "haiku" | "sonnet" | "opus";
  suggestedModel?: "haiku" | "sonnet" | "opus";
  result?: FeatureResult;
}

export interface Attachment {
  path: string;
  name: string;
  contentType: string;
  size: number;
}

/** Mensaje del hilo de la tarea. */
export interface ThreadMessage {
  author: "user" | "claude";
  kind: "message" | "question" | "summary";
  text: string;
  at?: Timestamp;
}

/** Vueltas máximas de conversación sobre una misma tarea (evita bucles). */
const MAX_CONVERSATION_RUNS = 30;

export interface FeatureResult {
  summary?: string;
  prUrl?: string;
  branch?: string;
  costUsd?: number;
  turns?: number;
  /** Tokens de todos los modelos usados en la tarea (incluye subagentes). */
  tokens?: { input: number; output: number; cache: number };
  /** Modelo pedido para la ejecución (vacío = el de la configuración de Claude Code). */
  model?: string;
  /** Coste y tokens por modelo realmente usado (Claude Code puede usar varios, p. ej. Haiku para subtareas). */
  models?: Record<string, { costUsd: number; tokens: number }>;
  error?: string;
}

const LOCK_LEASE_MS = 60_000;
export const FEATURE_LEASE_MS = 5 * 60_000;

/** Debe coincidir con promptHash() en functions/src/index.ts. Los adjuntos forman parte de la huella. */
export function promptHash(title: string, refinedPrompt: string, acceptanceCriteria: string[], attachments: string[] = []): string {
  return createHash("sha256")
    .update(JSON.stringify({ title, refinedPrompt, acceptanceCriteria, ...(attachments.length ? { attachments } : {}) }))
    .digest("hex");
}

/**
 * El runner se autentica como el usuario dueño de la runner key (token con claim runner=true).
 * Todo lo que hace pasa por las Security Rules: solo puede mover las tareas asignadas a ese usuario.
 */
export async function connect(cfg: RunnerConfig): Promise<{ db: Firestore; storage: FirebaseStorage; uid: string }> {
  const app = initializeApp(cfg.firebase);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  const fns = getFunctions(app, cfg.functionsRegion);
  if (cfg.emulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
    connectStorageEmulator(storage, "127.0.0.1", 9199);
  }
  const { data } = await httpsCallable<{ key: string }, { token: string }>(fns, "runnerSignIn")({ key: cfg.runnerKey });
  const { user } = await signInWithCustomToken(auth, data.token);
  return { db, storage, uid: user.uid };
}

export class Store {
  constructor(
    private db: Firestore,
    private storage: FirebaseStorage,
    private cfg: RunnerConfig,
    readonly uid: string,
  ) {}

  /** Avisos sobre la configuración (rama base, alojamiento…) que la app muestra junto al estado del runner. */
  warnings: RepoWarning[] = [];
  /** Qué sabe hacer este runner: abrir/mergear PRs (y dónde) y publicar OTA (canales). La app lo usa para ofrecerlo. */
  capabilities: { pr: "github" | "bitbucket" | null; ota: { channels: string[]; via: "eas" | "script" } | null } = { pr: null, ota: null };

  /** Descarga un adjunto de la tarea (Storage Rules: solo miembros del grupo). */
  async download(path: string): Promise<Uint8Array> {
    return new Uint8Array(await getBytes(ref(this.storage, path), 25 * 1024 * 1024));
  }

  project() {
    return doc(this.db, "projects", this.cfg.projectId);
  }
  features() {
    return collection(this.project(), "features");
  }
  feature(id: string) {
    return doc(this.features(), id);
  }
  /** Tareas aceptadas por este usuario y pendientes de ejecutar en este proyecto. */
  myQueue() {
    return query(this.features(), where("status", "==", "execute"), where("assignee", "==", this.uid));
  }

  /** Garantiza un único runner por usuario y proyecto. Devuelve una función para liberar el lock. */
  async acquireLock(): Promise<() => Promise<void>> {
    const ref = doc(this.project(), "runners", this.uid);
    const take = () =>
      runTransaction(this.db, async (tx) => {
        const lock = await tx.get(ref);
        const holder = lock.get("holder") as string | undefined;
        const until = (lock.get("leaseUntil") as Timestamp | undefined)?.toMillis() ?? 0;
        if (holder && holder !== this.cfg.runnerId && until > Date.now()) {
          throw new Error(`Ya tienes un runner activo para este proyecto (${holder})`);
        }
        tx.set(ref, { holder: this.cfg.runnerId, leaseUntil: Timestamp.fromMillis(Date.now() + LOCK_LEASE_MS), warnings: this.warnings, capabilities: this.capabilities });
      });
    await take();
    const timer = setInterval(() => {
      take().catch((err) => {
        console.error("[lock] lease perdido, saliendo:", err.message);
        process.exit(1);
      });
    }, LOCK_LEASE_MS / 3);
    return async () => {
      clearInterval(timer);
      await deleteDoc(ref).catch(() => undefined);
    };
  }

  /** Con el lock en mano, cualquier tarea mía en 'running' es huérfana de un runner anterior. */
  async recoverOrphans(): Promise<void> {
    const snap = await getDocs(query(this.features(), where("status", "==", "running"), where("assignee", "==", this.uid)));
    for (const d of snap.docs) {
      const retry = ((d.get("attempts") as number | undefined) ?? 0) < this.cfg.maxAttempts;
      await updateDoc(d.ref, retry
        ? { status: "execute", runnerId: deleteField(), leaseUntil: deleteField() }
        : { status: "failed", runnerId: deleteField(), leaseUntil: deleteField(), result: { error: "El runner se detuvo durante la ejecución" }, finishedAt: serverTimestamp() });
      console.log(`[recover] ${d.id} -> ${retry ? "execute" : "failed"}`);
    }
  }

  /** execute -> running de forma atómica. Devuelve la tarea si la reclamamos nosotros. */
  async claim(id: string): Promise<Feature | null> {
    const ref = this.feature(id);
    return runTransaction(this.db, async (tx) => {
      const d = await tx.get(ref);
      if (!d.exists() || d.get("status") !== "execute" || d.get("assignee") !== this.uid) return null;
      const attempts = ((d.get("attempts") as number | undefined) ?? 0) + 1;
      // Una tarea nueva tiene maxAttempts; una conversación (sesión existente) tiene un tope mayor.
      const limit = d.get("sessionId") ? MAX_CONVERSATION_RUNS : this.cfg.maxAttempts;
      if (attempts > limit) {
        tx.update(ref, { status: "failed", result: { error: "Máximo de intentos alcanzado" }, finishedAt: serverTimestamp() });
        return null;
      }
      tx.update(ref, {
        status: "running",
        runnerId: this.cfg.runnerId,
        startedAt: serverTimestamp(),
        leaseUntil: Timestamp.fromMillis(Date.now() + FEATURE_LEASE_MS),
        attempts,
      });
      return { ...(d.data() as Feature), attempts };
    });
  }

  /**
   * Defensa en profundidad: la tarea es mía, sigo siendo miembro del grupo, el prompt no cambió
   * desde que la acepté y la rama tiene el formato que genera acceptFeature.
   */
  async verifyAcceptance(id: string, feature: Feature): Promise<string | null> {
    if (feature.assignee !== this.uid) return "La tarea no está asignada a este usuario";
    const project = await getDoc(this.project());
    const group = await getDoc(doc(this.db, "groups", project.get("groupId")));
    if (!((group.get("members") ?? {}) as Record<string, string>)[this.uid]) return "Ya no eres miembro del grupo";
    const expected = promptHash(feature.title, feature.refinedPrompt, feature.acceptanceCriteria ?? [], (feature.attachments ?? []).map((a) => a.path));
    if (feature.promptHash !== expected) return "El prompt cambió después de aceptar la tarea";
    if (!feature.branch || !new RegExp(`^backcode/[a-z0-9-]{1,32}/${id}$`).test(feature.branch)) return "Nombre de rama no válido";
    return null;
  }

  /** Añade un mensaje de Claude al hilo de la tarea. */
  async postMessage(id: string, kind: "question" | "summary", text: string): Promise<void> {
    await addDoc(collection(this.feature(id), "messages"), { author: "claude", kind, text: text.slice(0, 4000), at: serverTimestamp() });
  }

  /** Hilo completo de la tarea, en orden. */
  async thread(id: string): Promise<ThreadMessage[]> {
    const snap = await getDocs(collection(this.feature(id), "messages"));
    return snap.docs.map((d) => d.data() as ThreadMessage).sort((a, b) => (a.at?.toMillis() ?? 0) - (b.at?.toMillis() ?? 0));
  }

  // --- Acciones (mergear PR, publicar OTA): las pide un admin y las ejecuta su runner ---

  /** Acciones pendientes que pedí yo en este proyecto. */
  myActions() {
    return query(collection(this.project(), "actions"), where("requestedBy", "==", this.uid), where("status", "==", "pending"));
  }

  async claimAction(id: string): Promise<Record<string, unknown> | null> {
    const ref = doc(this.project(), "actions", id);
    return runTransaction(this.db, async (tx) => {
      const d = await tx.get(ref);
      if (!d.exists() || d.get("status") !== "pending" || d.get("requestedBy") !== this.uid) return null;
      tx.update(ref, { status: "running", updatedAt: serverTimestamp() });
      return d.data();
    });
  }

  async finishAction(id: string, ok: boolean, result: Record<string, unknown>): Promise<void> {
    const clean = Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
    await updateDoc(doc(this.project(), "actions", id), { status: ok ? "done" : "failed", result: clean, updatedAt: serverTimestamp() });
  }

  async featureInfo(featureId: string): Promise<{ title: string; branch?: string; prUrl?: string; summary?: string; refinedPrompt: string }> {
    const d = await getDoc(this.feature(featureId));
    const result = (d.get("result") as FeatureResult | undefined) ?? {};
    return { title: String(d.get("title") ?? ""), branch: d.get("branch") as string | undefined, prUrl: result.prUrl, summary: result.summary, refinedPrompt: String(d.get("refinedPrompt") ?? "") };
  }

  async setPrUrl(featureId: string, url: string): Promise<void> {
    await updateDoc(this.feature(featureId), { "result.prUrl": url });
  }

  async prUrlOf(featureId: string): Promise<string | undefined> {
    return ((await getDoc(this.feature(featureId))).get("result") as FeatureResult | undefined)?.prUrl;
  }

  /** Mis tareas con PR abierto (terminadas y sin mergear), para vigilar si chocan con la rama base. */
  async myOpenPrs(): Promise<{ id: string; branch: string; prUrl?: string; conflicts: string[] }[]> {
    const snap = await getDocs(query(collection(this.project(), "features"), where("assignee", "==", this.uid), where("status", "==", "done")));
    return snap.docs
      .filter((d) => d.get("branch") && !d.get("merged"))
      .map((d) => ({ id: d.id, branch: String(d.get("branch")), prUrl: (d.get("result") as FeatureResult | undefined)?.prUrl, conflicts: (d.get("conflicts") as string[] | undefined) ?? [] }));
  }

  /** Marca (o desmarca, con []) los ficheros en conflicto de la rama de una tarea con la base. */
  async setConflicts(featureId: string, files: string[]): Promise<void> {
    await updateDoc(this.feature(featureId), { conflicts: files.length ? files.slice(0, 50) : deleteField() });
  }

  async markMerged(featureId: string, sha?: string): Promise<void> {
    await updateDoc(this.feature(featureId), { merged: { at: serverTimestamp(), by: this.uid, sha: sha ?? "" } });
  }

  /** Tareas mergeadas que aún no constan como desplegadas en ese canal (con el commit del merge). */
  async mergedNotDeployed(channel: string): Promise<{ id: string; sha: string }[]> {
    const snap = await getDocs(query(collection(this.project(), "features"), where("status", "==", "done")));
    return snap.docs
      .filter((d) => d.get("merged.sha") && !d.get(`deployed.${channel}`))
      .map((d) => ({ id: d.id, sha: String(d.get("merged.sha")) }));
  }

  async markDeployed(featureId: string, channel: string, sha: string): Promise<void> {
    await updateDoc(this.feature(featureId), { [`deployed.${channel}`]: { at: serverTimestamp(), by: this.uid, sha } });
  }

  knowledge() {
    return doc(this.project(), "knowledge", "repo");
  }

  /** Commit y fecha del mapa del repositorio guardado (si existe). */
  async knowledgeState(): Promise<{ exists: boolean; commit?: string; updatedAt?: number; iconPath?: string; iconHint?: string }> {
    const d = await getDoc(this.knowledge());
    return {
      exists: d.exists(),
      commit: d.get("commit") as string | undefined,
      updatedAt: (d.get("updatedAt") as Timestamp | undefined)?.toMillis(),
      iconPath: d.get("iconPath") as string | undefined,
      iconHint: d.get("iconHint") as string | undefined,
    };
  }

  /** Sube el icono encontrado en el repo y lo enlaza en el mapa (el documento ya debe existir). */
  async saveRepoIcon(data: Buffer, contentType: string): Promise<void> {
    const path = `projects/${this.cfg.projectId}/branding/repo`;
    await uploadBytes(ref(this.storage, path), new Uint8Array(data), { contentType });
    await setDoc(this.knowledge(), { iconPath: path, updatedBy: this.uid, updatedAt: serverTimestamp() }, { merge: true });
  }

  async saveKnowledge(summary: string, commit: string, costUsd: number, iconHint?: string): Promise<void> {
    // merge: conserva el icono del repo (iconPath) al regenerar el mapa.
    // totalCostUsd/runs: coste acumulado de todos los mapas generados (las reglas comprueban que suma exactamente costUsd).
    const data = { summary, commit, costUsd, totalCostUsd: increment(costUsd), runs: increment(1), updatedBy: this.uid, updatedAt: serverTimestamp() };
    // Si el servidor aún no admite iconHint (reglas sin desplegar), el mapa se guarda igual sin la pista.
    await setDoc(this.knowledge(), { ...data, iconHint: iconHint ?? deleteField() }, { merge: true }).catch(() => setDoc(this.knowledge(), data, { merge: true }));
  }

  /** Publica la cuota del plan de este usuario en todos sus grupos (es de la cuenta, no del proyecto). */
  /** Avisa cuando alguien pide refrescar la cuota de este usuario (botón ↻ de la app) en cualquiera de sus grupos. */
  async watchQuotaRequests(onRequest: () => void): Promise<() => void> {
    const groups = await getDocs(query(collection(this.db, "groups"), where("memberIds", "array-contains", this.uid)));
    let last = Date.now();
    const unsubs = groups.docs.map((g) =>
      onSnapshot(
        doc(this.db, "groups", g.id, "quotaRequests", this.uid),
        (d) => {
          const at = (d.get("at") as Timestamp | undefined)?.toMillis() ?? 0;
          if (at > last) {
            last = at;
            onRequest();
          }
        },
        () => undefined,
      ),
    );
    return () => unsubs.forEach((u) => u());
  }

  async saveQuota(quota: Quota): Promise<void> {
    const groups = await getDocs(query(collection(this.db, "groups"), where("memberIds", "array-contains", this.uid)));
    await Promise.all(groups.docs.map((g) => setDoc(doc(this.db, "groups", g.id, "quota", this.uid), { ...quota, updatedAt: serverTimestamp() })));
  }

  async projectInfo(): Promise<{ name: string; context: string }> {
    const d = await getDoc(this.project());
    const oneLine = (s: unknown) => String(s ?? "").replaceAll(/[\r\n]+/g, " ").slice(0, 100);
    return { name: oneLine(d.get("name")), context: String(d.get("context") ?? "").slice(0, 8000) };
  }

  async extendLease(id: string): Promise<void> {
    await updateDoc(this.feature(id), { leaseUntil: Timestamp.fromMillis(Date.now() + FEATURE_LEASE_MS) });
  }

  async event(id: string, type: string, text: string): Promise<void> {
    await addDoc(collection(this.feature(id), "events"), { at: serverTimestamp(), type, text: text.slice(0, 1000) })
      .catch((err) => console.error("[event]", err.message));
  }

  async finish(id: string, status: "done" | "failed" | "waiting", result: FeatureResult, sessionId?: string): Promise<void> {
    const clean = Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
    await updateDoc(this.feature(id), {
      status,
      result: clean,
      ...(sessionId ? { sessionId } : {}),
      finishedAt: serverTimestamp(),
      leaseUntil: deleteField(),
      runnerId: deleteField(),
    });
  }

  /** Devuelve la tarea a la cola (p. ej. al parar el runner con Ctrl+C). */
  async requeue(id: string): Promise<void> {
    await updateDoc(this.feature(id), { status: "execute", runnerId: deleteField(), leaseUntil: deleteField() });
  }
}
