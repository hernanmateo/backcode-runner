import { getDocs, onSnapshot, type Query, type QueryDocumentSnapshot } from "firebase/firestore";

/** De dónde salen los documentos: un listener (con si están al día del servidor y si cambió alguno) y una lectura suelta. */
export interface QuerySource<D> {
  listen(onData: (docs: D[], fresh: boolean, changed: boolean) => void, onError: (err: Error) => void): () => void;
  fetch(): Promise<D[]>;
}

export function firestoreSource(q: Query): QuerySource<QueryDocumentSnapshot> {
  return {
    listen: (onData, onError) => onSnapshot(q, { includeMetadataChanges: true }, (snap) => onData(snap.docs, !snap.metadata.fromCache, snap.docChanges().length > 0), onError),
    fetch: async () => (await getDocs(q)).docs,
  };
}

/** Tras un error del listener, cuándo se vuelve a escuchar si alguien espera sus cambios (watch). */
const RETRY_MS = 60_000;

/**
 * Consulta que el runner relee a menudo («Pendiente de desplegar» cada 3 min: todas las tareas terminadas y todas las
 * acciones del proyecto), servida desde un listener: Firestore cobra la lectura inicial y después solo los documentos que
 * cambian, en vez de todo el historial cada vez. Mientras el listener no tiene datos al día del servidor (arrancando, sin
 * conexión o tras un error), se lee como antes, con getDocs. El listener empieza con el primer uso (`source` es perezoso).
 */
export class LiveQuery<D> {
  private docs: D[] | null = null;
  private unsub: (() => void) | null = null;
  private first: Promise<void> = Promise.resolve();
  private src: QuerySource<D> | null = null;
  private readonly watchers = new Set<() => void>();

  constructor(private readonly source: () => QuerySource<D>) {}

  async get(): Promise<D[]> {
    this.start();
    await this.first;
    return this.docs ?? (await this.src!.fetch());
  }

  /** Avisa de cada cambio en la consulta después de los primeros datos. */
  watch(onChange: () => void): () => void {
    this.watchers.add(onChange);
    this.start();
    return () => void this.watchers.delete(onChange);
  }

  private start(): void {
    if (this.unsub) return;
    this.src ??= this.source();
    let settle = () => {};
    this.first = new Promise((resolve) => (settle = resolve));
    let seen = false;
    this.unsub = this.src.listen(
      (docs, fresh, changed) => {
        this.docs = fresh ? docs : null;
        if (seen && changed) for (const w of this.watchers) w();
        seen = true;
        settle();
      },
      (err) => {
        console.warn(`[live] ${err.message}`);
        this.docs = null;
        this.unsub = null;
        settle();
        if (this.watchers.size) setTimeout(() => this.watchers.size && this.start(), RETRY_MS).unref();
      },
    );
  }
}
