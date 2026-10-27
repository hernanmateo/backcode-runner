// Prueba de arranque desde la terminal (la usa el script ota-publish.sh de la app antes de publicar).
// Uso: node dist/smoke-cli.js <carpeta de la app> [--from <carpeta con los ficheros locales>] [VAR=valor…]
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { smokeTest } from "./smoke.js";

const args = process.argv.slice(2);
const from = args.indexOf("--from") >= 0 ? args.splice(args.indexOf("--from"), 2)[1] : undefined;
const [dir, ...vars] = args;
if (!dir) {
  console.error("uso: smoke-cli <carpeta de la app> [VAR=valor…]");
  process.exit(2);
}
const env = Object.fromEntries(vars.map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
const result = await smokeTest(resolve(dir), env, tmpdir(), resolve(from ?? dir));
console.log(result.detail);
if (result.screenshot) console.log(`  captura: ${result.screenshot}`);
process.exit(result.ok ? 0 : 1);
