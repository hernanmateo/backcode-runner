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
import type { RunnerConfig } from "./config.js";
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
  /** Sesión de Claude de esta tarea: si existe, el runner la continúa en lugar de empezar de cero. */
  sessionId?: string;
  result?: FeatureResult;
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
  error?: string;
}

const LOCK_LEASE_MS = 60_000;
export const FEATURE_LEASE_MS = 5 * 60_000;

/** Debe coincidir con promptHash() en functions/src/index.ts. */
export function promptHash(title: string, refinedPrompt: string, acceptanceCriteria: string[]): string {
  return createHash("sha256").update(JSON.stringify({ title, refinedPrompt, acceptanceCriteria })).digest("hex");
}

/**
 * El runner se autentica como el usuario dueño de la runner key (token con claim runner=true).
 * Todo lo que hace pasa por las Security Rules: solo puede mover las tareas asignadas a ese usuario.
 */
export async function connect(cfg: RunnerConfig): Promise<{ db: Firestore; uid: string }> {
  const app = initializeApp(cfg.firebase);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const fns = getFunctions(app, cfg.functionsRegion);
  if (cfg.emulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  }
  const { data } = await httpsCallable<{ key: string }, { token: string }>(fns, "runnerSignIn")({ key: cfg.runnerKey });
  const { user } = await signInWithCustomToken(auth, data.token);
  return { db, uid: user.uid };
}

export class Store {
  constructor(private db: Firestore, private cfg: RunnerConfig, readonly uid: string) {}

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
        tx.set(ref, { holder: this.cfg.runnerId, leaseUntil: Timestamp.fromMillis(Date.now() + LOCK_LEASE_MS) });
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
    const expected = promptHash(feature.title, feature.refinedPrompt, feature.acceptanceCriteria ?? []);
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

  knowledge() {
    return doc(this.project(), "knowledge", "repo");
  }

  /** Commit y fecha del mapa del repositorio guardado (si existe). */
  async knowledgeState(): Promise<{ commit?: string; updatedAt?: number }> {
    const d = await getDoc(this.knowledge());
    return { commit: d.get("commit") as string | undefined, updatedAt: (d.get("updatedAt") as Timestamp | undefined)?.toMillis() };
  }

  async saveKnowledge(summary: string, commit: string, costUsd: number): Promise<void> {
    await setDoc(this.knowledge(), { summary, commit, costUsd, updatedBy: this.uid, updatedAt: serverTimestamp() });
  }

  /** Publica la cuota del plan de este usuario en todos sus grupos (es de la cuenta, no del proyecto). */
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
