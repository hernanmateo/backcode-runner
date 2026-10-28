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
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { connectStorageEmulator, getBytes, getMetadata, getStorage, ref, uploadBytes, type FirebaseStorage } from "firebase/storage";
import type { RunnerConfig } from "./config.js";
import type { FirebaseDeployEnv } from "./firebase-env.js";
import type { RepoWarning } from "./git.js";
import type { Device } from "./devices.js";
import { setLang, t } from "./i18n.js";
import type { Quota } from "./quota.js";
import { readState, updateState } from "./paths.js";

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
  model?: "auto" | "haiku" | "sonnet" | "opus" | "fable";
  /** Ficheros en conflicto con la base que marcó la comprobación periódica. */
  conflicts?: string[];
  suggestedModel?: "haiku" | "sonnet" | "opus" | "fable";
  /** Modo plan: antes de tocar código, Claude propone un plan que quien la ejecuta refina en el hilo y aprueba. */
  planFirst?: boolean;
  /** Plan aprobado (desde ahí, la sesión implementa). */
  planApproved?: { by: string };
  result?: FeatureResult;
}

/** Control en directo de una tarea: lo escribe la app (parar, pedir Remote Control o volver) y el runner (abierto). */
export interface LiveControl {
  stopRequest?: Timestamp;
  remote?: RemoteState;
}

/** Remote Control de la sesión de la tarea: lo pide la app (requested/return) y lo lleva el runner (open/failed). */
export interface RemoteState {
  state: "requested" | "open" | "return" | "failed";
  url?: string;
  error?: string;
  at?: Timestamp;
}

export interface Attachment {
  path: string;
  name: string;
  contentType: string;
  size: number;
}

/** Mensaje del hilo de la tarea. */
export interface ThreadMessage {
  id?: string;
  author: "user" | "claude";
  kind: "message" | "question" | "summary" | "plan";
  text: string;
  at?: Timestamp;
  /** Cuándo lo recibió Claude (mensajes de la persona). */
  read?: Timestamp;
}

/** Encargo de refinado que prepara refineFeature: instrucciones, petición (con contexto) y adjuntos. */
export interface RefineJob {
  uid: string;
  instructions: string;
  input: string;
  attachments?: Attachment[];
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
  /** Pasos a mano tras mergear (desplegar reglas, migraciones…): la app los muestra con botón de copiar y, si el repo
   * declara un destino backcode:deploy:<deployTarget>, con botón para ejecutarlo con el runner de un admin. */
  afterMerge?: { why: string; command?: string; deployTarget?: string }[];
  /** Modo plan: la vuelta terminó con un plan propuesto, pendiente de aprobar. */
  planReady?: boolean;
  error?: string;
}

const LOCK_LEASE_MS = 60_000;
export const FEATURE_LEASE_MS = 5 * 60_000;
/** «Sigo vivo» de las acciones (merge, OTA, builds…): se renueva cada minuto mientras dura. */
export const ACTION_LEASE_MS = 3 * 60_000;

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
  /** Qué sabe hacer este runner: abrir/mergear PRs (y dónde), publicar OTA (canales) y builds locales para testers. La app lo usa para ofrecerlo. */
  // expo: el repo es una app Expo (la app ofrece la guía de OTA aunque aún no tenga).
  // refine: sabe refinar ideas con Claude Code (refineFeature solo se lo encarga a runners que lo anuncian).
  // live: recibe los mensajes del hilo mientras Claude trabaja (y se puede parar); remoteControl: puede abrir la sesión
  // de una tarea en la app de Claude.
  capabilities: { pr: "github" | "bitbucket" | null; expo: boolean; deploys: { id: string; name: string; dir: string; env?: FirebaseDeployEnv }[]; ota: { channels: string[]; via: "eas" | "script" } | null; build: { platforms: ("ios" | "android")[] } | null; install?: { platforms: ("ios" | "android")[] } | null; refine: boolean; live: boolean; remoteControl: boolean } = { pr: null, expo: false, deploys: [], ota: null, build: null, refine: true, live: true, remoteControl: false };

  /**
   * Idioma del perfil del usuario en la app (users/{uid}.lang) para todo lo que escribe el runner; se sigue en vivo, así
   * que cambiarlo en la app aplica sin reiniciar. Resuelve tras la primera lectura (o si falla) con la baja del listener.
   */
  watchLang(): Promise<() => void> {
    return new Promise((resolve) => {
      let ready = false;
      const done = () => {
        if (!ready) {
          ready = true;
          resolve(unsubscribe);
        }
      };
      const unsubscribe = onSnapshot(
        doc(this.db, "users", this.uid),
        (d) => {
          setLang(d.get("lang"));
          // El panel usa el mismo idioma que la app (antes de que lo elijas en él).
          if (["es", "en", "ca"].includes(d.get("lang")) && readState().profileLang !== d.get("lang")) updateState({ profileLang: d.get("lang") });
          done();
        },
        done,
      );
    });
  }

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

  /**
   * Móviles de este ordenador para «Instalar en mi móvil» (projects/{pid}/runners/{uid}/private/devices): solo los lee
   * su dueño. Nombre, modelo, sistema y si está listo; nada más.
   */
  async saveDevices(devices: Device[]): Promise<void> {
    await setDoc(doc(this.project(), "runners", this.uid, "private", "devices"), { devices: JSON.parse(JSON.stringify(devices.slice(0, 20))) as Device[], updatedAt: serverTimestamp() });
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
          throw new Error(t("store.lockHeld", { holder }));
        }
        tx.set(ref, { holder: this.cfg.runnerId, leaseUntil: Timestamp.fromMillis(Date.now() + LOCK_LEASE_MS), warnings: this.warnings, capabilities: this.capabilities });
      });
    await take();
    const timer = setInterval(() => {
      take().catch((err) => {
        console.error(`[lock] ${t("store.leaseLost")}`, err.message);
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
        : { status: "failed", runnerId: deleteField(), leaseUntil: deleteField(), result: { error: t("store.orphan") }, finishedAt: serverTimestamp() });
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
        tx.update(ref, { status: "failed", result: { error: t("store.maxAttempts") }, finishedAt: serverTimestamp() });
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
    if (feature.assignee !== this.uid) return t("store.notAssigned");
    const project = await getDoc(this.project());
    const group = await getDoc(doc(this.db, "groups", project.get("groupId")));
    if (!((group.get("members") ?? {}) as Record<string, string>)[this.uid]) return t("store.notMember");
    const expected = promptHash(feature.title, feature.refinedPrompt, feature.acceptanceCriteria ?? [], (feature.attachments ?? []).map((a) => a.path));
    if (feature.promptHash !== expected) return t("store.promptChanged");
    if (!feature.branch || !new RegExp(`^backcode/[a-z0-9-]{1,32}/${id}$`).test(feature.branch)) return t("store.badBranch");
    return null;
  }

  /** Añade un mensaje de Claude al hilo de la tarea (un plan puede ser bastante más largo que el resto). */
  async postMessage(id: string, kind: "question" | "summary" | "plan", text: string): Promise<void> {
    await addDoc(collection(this.feature(id), "messages"), { author: "claude", kind, text: text.slice(0, kind === "plan" ? 20_000 : 4000), at: serverTimestamp() });
  }

  /** Hilo completo de la tarea, en orden. */
  async thread(id: string): Promise<ThreadMessage[]> {
    const snap = await getDocs(collection(this.feature(id), "messages"));
    return snap.docs.map((d) => ({ ...(d.data() as ThreadMessage), id: d.id })).sort((a, b) => (a.at?.toMillis() ?? 0) - (b.at?.toMillis() ?? 0));
  }

  /** Mensajes de la persona en el hilo, en vivo (para pasárselos a Claude mientras trabaja). */
  watchUserMessages(id: string, onChange: (messages: ThreadMessage[]) => void): () => void {
    return onSnapshot(
      query(collection(this.feature(id), "messages"), where("author", "==", "user")),
      (snap) => onChange(snap.docs.map((d) => ({ ...(d.data() as ThreadMessage), id: d.id })).sort((a, b) => (a.at?.toMillis() ?? 0) - (b.at?.toMillis() ?? 0))),
      (err) => console.warn(`[messages] ${err.message}`),
    );
  }

  /** Marca mensajes de la persona como recibidos por Claude (la app lo muestra como «leído»). */
  async markRead(id: string, mids: string[]): Promise<void> {
    if (!mids.length) return;
    const batch = writeBatch(this.db);
    for (const mid of mids) batch.update(doc(this.feature(id), "messages", mid), { read: serverTimestamp() });
    await batch.commit().catch((err) => console.warn(`[messages] ${err.message}`));
  }

  /** Control en directo de la tarea (features/{id}/control/live): la app pide parar o abrir/cerrar Remote Control. */
  watchControl(id: string, onChange: (control: LiveControl) => void): () => void {
    return onSnapshot(doc(this.feature(id), "control", "live"), (d) => onChange((d.data() ?? {}) as LiveControl), (err) => console.warn(`[control] ${err.message}`));
  }

  async control(id: string): Promise<LiveControl> {
    return ((await getDoc(doc(this.feature(id), "control", "live"))).data() ?? {}) as LiveControl;
  }

  /** Estado del Remote Control de la tarea (null = cerrado). */
  async setRemote(id: string, remote: RemoteState | null): Promise<void> {
    // mergeFields: `remote` se sustituye entero (no se mezcla con lo que pidió la app).
    await setDoc(doc(this.feature(id), "control", "live"), { remote: remote ?? deleteField() }, { mergeFields: ["remote"] });
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
      tx.update(ref, { status: "running", updatedAt: serverTimestamp(), leaseUntil: Timestamp.fromMillis(Date.now() + ACTION_LEASE_MS) });
      return d.data();
    });
  }

  /** «Sigo vivo» de una acción en marcha: si el runner se cae, la app deja de tratarla como en curso al caducar. */
  async extendActionLease(id: string): Promise<void> {
    await updateDoc(doc(this.project(), "actions", id), { leaseUntil: Timestamp.fromMillis(Date.now() + ACTION_LEASE_MS) });
  }

  /** Al arrancar: las acciones propias que se quedaron «en marcha» (el runner se cayó) se marcan como interrumpidas. */
  async recoverActions(): Promise<void> {
    const snap = await getDocs(query(collection(this.project(), "actions"), where("requestedBy", "==", this.uid), where("status", "==", "running")));
    for (const d of snap.docs) {
      await updateDoc(d.ref, { status: "failed", result: { error: t("store.actionInterrupted") }, updatedAt: serverTimestamp() }).catch(() => undefined);
      console.log(`[recover] action ${d.id} -> failed`);
    }
  }

  // --- Refinado de ideas con Claude Code: lo encarga refineFeature (servidor) a mi runner si lo activé en la app ---

  /** Encargos de refinado pendientes que pedí yo en este proyecto. */
  myRefineJobs() {
    return query(collection(this.project(), "refineJobs"), where("uid", "==", this.uid), where("status", "==", "pending"));
  }

  /** pending -> running de forma atómica. Devuelve el encargo si lo reclamamos nosotros. */
  async claimRefine(id: string): Promise<RefineJob | null> {
    const ref = doc(this.project(), "refineJobs", id);
    return runTransaction(this.db, async (tx) => {
      const d = await tx.get(ref);
      if (!d.exists() || d.get("status") !== "pending" || d.get("uid") !== this.uid) return null;
      tx.update(ref, { status: "running", updatedAt: serverTimestamp() });
      return d.data() as RefineJob;
    });
  }

  /** Lo que está haciendo Claude (p. ej. «Leyendo src/app.ts»): el servidor lo muestra en vivo en la app. */
  async refineActivity(id: string, activity: string): Promise<void> {
    await updateDoc(doc(this.project(), "refineJobs", id), { activity: activity.slice(0, 300), updatedAt: serverTimestamp() }).catch(() => undefined);
  }

  async finishRefine(id: string, outcome: { result: Record<string, unknown>; model: string; costUsd: number } | { error: string }): Promise<void> {
    await updateDoc(doc(this.project(), "refineJobs", id), {
      ...("error" in outcome ? { status: "failed", error: outcome.error.slice(0, 1000) } : { status: "done", ...outcome }),
      updatedAt: serverTimestamp(),
    });
  }

  /** La sesión de Claude se guarda en cuanto empieza: si el runner se cae, el reintento la continúa (no empieza de cero). */
  async setSession(id: string, sessionId: string): Promise<void> {
    await updateDoc(this.feature(id), { sessionId }).catch(() => undefined);
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
  /** Guarda en el proyecto la URL pública del repo (para que quien aún no lo tiene pueda clonarlo desde Conectar). */
  async saveRepoUrl(url: string): Promise<void> {
    const project = await getDoc(this.project());
    if (project.get("repoUrl") !== url) await updateDoc(this.project(), { repoUrl: url });
  }

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

  /** MD5 (base64) del icono del repo ya subido, o undefined si no hay. */
  async repoIconMd5(): Promise<string | undefined> {
    return getMetadata(ref(this.storage, `projects/${this.cfg.projectId}/branding/repo`)).then((m) => m.md5Hash, () => undefined);
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

  // --- Proyectos nuevos desde una idea (users/{uid}/scaffolds): los crea el servidor y los atiende cualquier runner mío ---

  /** Ajustes de la app para crear proyectos (carpeta de proyectos, proveedor por defecto). Solo los escribe la app. */
  watchWorkspace(onChange: (w: { projectsDir?: string }) => void): () => void {
    return onSnapshot(
      doc(this.db, "users", this.uid, "private", "workspace"),
      (d) => onChange({ projectsDir: typeof d.get("projectsDir") === "string" ? (d.get("projectsDir") as string) : undefined }),
      () => undefined,
    );
  }

  async workspace(): Promise<{ projectsDir?: string }> {
    const d = await getDoc(doc(this.db, "users", this.uid, "private", "workspace")).catch(() => null);
    return { projectsDir: typeof d?.get("projectsDir") === "string" ? (d.get("projectsDir") as string) : undefined };
  }

  /** Lo que este ordenador puede hacer al crear un proyecto (lo muestra la app; nunca lleva tokens). */
  async saveMachine(report: Record<string, unknown>): Promise<void> {
    await setDoc(doc(this.db, "users", this.uid, "private", "machine"), { ...report, updatedAt: serverTimestamp() });
  }

  myScaffolds() {
    return query(collection(this.db, "users", this.uid, "scaffolds"), where("status", "==", "pending"));
  }

  /** pending -> running de forma atómica: con varios runners del mismo usuario, solo uno lo crea. */
  async claimScaffold(id: string): Promise<Record<string, unknown> | null> {
    const ref = doc(this.db, "users", this.uid, "scaffolds", id);
    return runTransaction(this.db, async (tx) => {
      const d = await tx.get(ref);
      if (!d.exists() || d.get("status") !== "pending") return null;
      tx.update(ref, { status: "running", updatedAt: serverTimestamp(), leaseUntil: Timestamp.fromMillis(Date.now() + ACTION_LEASE_MS) });
      return d.data();
    });
  }

  async extendScaffoldLease(id: string): Promise<void> {
    await updateDoc(doc(this.db, "users", this.uid, "scaffolds", id), { leaseUntil: Timestamp.fromMillis(Date.now() + ACTION_LEASE_MS) });
  }

  async scaffoldActivity(id: string, activity: string): Promise<void> {
    await updateDoc(doc(this.db, "users", this.uid, "scaffolds", id), { activity: activity.slice(0, 300), updatedAt: serverTimestamp() }).catch(() => undefined);
  }

  async finishScaffold(id: string, ok: boolean, result: { repoUrl?: string; repoPath?: string; error?: string }): Promise<void> {
    const clean = Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
    await updateDoc(doc(this.db, "users", this.uid, "scaffolds", id), { status: ok ? "done" : "failed", result: clean, updatedAt: serverTimestamp() });
  }

  /** Al arrancar: los que se quedaron «en marcha» con el lease caducado (se cayó el runner que los creaba) fallan. */
  async recoverScaffolds(): Promise<void> {
    const snap = await getDocs(query(collection(this.db, "users", this.uid, "scaffolds"), where("status", "==", "running")));
    for (const d of snap.docs) {
      if (((d.get("leaseUntil") as Timestamp | undefined)?.toMillis() ?? 0) > Date.now()) continue;
      await updateDoc(d.ref, { status: "failed", result: { error: t("scaffold.interrupted") }, updatedAt: serverTimestamp() }).catch(() => undefined);
      console.log(`[recover] scaffold ${d.id} -> failed`);
    }
  }

  /** La URL del repo recién creado, en su proyecto (las Rules solo dejan al runner escribir repoUrl). */
  async saveRepoUrlOf(projectId: string, url: string): Promise<void> {
    await updateDoc(doc(this.db, "projects", projectId), { repoUrl: url });
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

  async finish(id: string, status: "done" | "failed" | "waiting" | "execute", result: FeatureResult, sessionId?: string): Promise<void> {
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
