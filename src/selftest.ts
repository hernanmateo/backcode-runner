// `backcode selftest`: prueba de humo del ejecutable antes de publicarlo (scripts/build-binaries.mjs la pasa al compilar el
// de este ordenador, también en GitHub Actions y en el plan B de scripts/release-runner.sh). Sin credenciales ni red
// exterior: un servidor HTTP propio en 127.0.0.1 que responde a trozos (como los streams de Firestore), un puerto cerrado y
// el cliente de Firestore contra un emulador inexistente. Todo tiene que acabar en pocos segundos y sin quemar CPU. Pilla
// ejecutables que no arrancan, se cuelgan o dan vueltas en la red; el bucle al 100 % del 4-11-2026 (compilado con Bun 1.3.2)
// no se reproduce sin conectarse de verdad a Backcode: contra eso protege la versión de Bun fijada en .bun-version.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { initializeApp } from "firebase/app";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, onSnapshot, setLogLevel } from "firebase/firestore";

/** Por encima de esto (CPU / tiempo de reloj) se considera que algo da vueltas en vez de esperar. */
const MAX_CPU = 0.5;
const STEP_TIMEOUT_MS = 20_000;

const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no acabó en ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS))]);

async function measure(name: string, fn: () => Promise<void>): Promise<void> {
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  await withTimeout(fn(), name);
  const wall = Math.max(1, Date.now() - t0);
  const used = process.cpuUsage(cpu0);
  const ratio = (used.user + used.system) / 1000 / wall;
  console.log(`  ${name}: ${wall} ms, CPU ${Math.round(ratio * 100)} %`);
  // Solo cuenta en pasos que esperan (más de 1 s): uno cortísimo puede usar mucha CPU sin que signifique nada.
  if (wall > 1000 && ratio > MAX_CPU) throw new Error(`${name}: ${Math.round(ratio * 100)} % de CPU esperando (¿bucle?)`);
}

async function main(): Promise<void> {
  console.log("selftest");
  // 1. Un stream HTTP lento leído entero (lectura de socket con pausas).
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    let n = 0;
    const timer = setInterval(() => {
      res.write("x\n");
      if (++n === 6) {
        clearInterval(timer);
        res.end();
      }
    }, 300);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await measure("stream HTTP", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const reader = res.body!.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    if (bytes !== 12) throw new Error(`stream HTTP: ${bytes} bytes en vez de 12`);
  });
  // 2. Un puerto cerrado: tiene que fallar enseguida.
  const closed = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await measure("puerto cerrado", async () => {
    const failed = await fetch(`http://127.0.0.1:${closed}/`).then(
      () => false,
      () => true,
    );
    if (!failed) throw new Error("puerto cerrado: la petición no falló");
  });
  // 3. El cliente de Firestore (el mismo código con el que se conecta el runner) contra un emulador que no existe: tiene que
  //    rendirse («offline») esperando, no dando vueltas.
  await measure("Firestore sin servidor", async () => {
    const app = initializeApp({ projectId: "demo-selftest", apiKey: "selftest" }, "selftest");
    const db = getFirestore(app);
    setLogLevel("silent");
    connectFirestoreEmulator(db, "127.0.0.1", closed);
    await getDoc(doc(db, "selftest/x")).catch(() => undefined);
    // Y una escucha abierta 4 s, como el runner con sus colecciones: el cliente reintenta con espera, sin dar vueltas.
    const stop = onSnapshot(doc(db, "selftest/y"), () => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 4000));
    stop();
  });
  server.close();
  console.log("✓ selftest");
}

main().then(
  () => process.exit(0),
  (e: Error) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  },
);
