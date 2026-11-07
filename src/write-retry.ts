/**
 * Escrituras en Firestore que la app espera para dejar de cargar (el resultado de una petición de control, el estado
 * «abierta» de Remote Control): un fallo suelto (red, token a medio refrescar) no debe dejarla esperando para siempre.
 * Se reintenta unas pocas veces con espera; si aun así falla, se lanza el último error.
 */
export const WRITE_RETRY_DELAYS = [1_000, 3_000, 8_000];

export async function retryWrite<T>(fn: () => Promise<T>, opts: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const delays = opts.delaysMs ?? WRITE_RETRY_DELAYS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}
