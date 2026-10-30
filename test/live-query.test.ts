import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveQuery, type QuerySource } from "../src/live-query.js";

/** Fuente de prueba: el test decide qué entrega el listener y cuenta las lecturas sueltas. */
function fakeSource(server: string[]) {
  const s = {
    listens: 0,
    fetches: 0,
    onData: (_docs: string[], _fresh: boolean, _changed: boolean) => {},
    onError: (_err: Error) => {},
    source: (): QuerySource<string> => ({
      listen: (onData, onError) => {
        s.listens++;
        s.onData = onData;
        s.onError = onError;
        return () => {};
      },
      fetch: async () => (s.fetches++, [...server]),
    }),
  };
  return s;
}

test("LiveQuery: con datos al día del servidor no vuelve a leer la consulta", async () => {
  const src = fakeSource(["a"]);
  const live = new LiveQuery(src.source);
  const first = live.get();
  src.onData(["a"], true, true);
  assert.deepEqual(await first, ["a"]);
  src.onData(["a", "b"], true, true);
  assert.deepEqual(await live.get(), ["a", "b"]);
  assert.equal(src.listens, 1);
  assert.equal(src.fetches, 0);
});

test("LiveQuery: sin datos al día (caché, sin conexión o error) lee como antes", async () => {
  const src = fakeSource(["servidor"]);
  const live = new LiveQuery(src.source);
  const first = live.get();
  src.onData(["caché"], false, true);
  assert.deepEqual(await first, ["servidor"]);
  src.onData(["al día"], true, true);
  assert.deepEqual(await live.get(), ["al día"]);
  src.onError(new Error("sin permiso"));
  const after = live.get();
  assert.equal(src.listens, 2, "tras un error vuelve a escuchar en el siguiente uso");
  src.onError(new Error("sigue sin permiso"));
  assert.deepEqual(await after, ["servidor"]);
  assert.equal(src.fetches, 2);
});

test("LiveQuery: watch avisa de los cambios después de los primeros datos, no de los de solo metadatos", async () => {
  const src = fakeSource([]);
  const live = new LiveQuery(src.source);
  let calls = 0;
  const stop = live.watch(() => calls++);
  src.onData(["a"], true, true);
  assert.equal(calls, 0);
  src.onData(["a"], true, false);
  assert.equal(calls, 0);
  src.onData(["b", "a"], true, true);
  assert.equal(calls, 1);
  assert.deepEqual(await live.get(), ["b", "a"]);
  stop();
  src.onData(["c", "b", "a"], true, true);
  assert.equal(calls, 1);
  assert.equal(src.listens, 1, "watch y get comparten el listener");
});
