import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { newer, RELEASES_REPO } from "./autoupdate.js";

// «Backcode Runner.app» (la ventana de macOS) no se actualizaba nunca: el runner de ~/.backcode/bin sí (autoupdate.ts),
// pero la app se quedaba en la versión del DMG con el que se instaló. Aquí el servicio la sustituye por la del DMG de la
// última Release: SHA-256 contra SHA256SUMS, firma válida y notarizada del MISMO equipo que la instalada, y cambio
// atómico (la app abierta sigue con la suya; al volver a abrirla ya es la nueva).

const exec = promisify(execFile);
const APP_NAME = "Backcode Runner.app";
const DMG = "Backcode-Runner.dmg";
const EVERY_MS = 30 * 60_000;
let lastCheck = 0;
let failed = "";

/** La app instalada (en /Applications o ~/Applications), o null. */
function installedApp(): string | null {
  return [join("/Applications", APP_NAME), join(homedir(), "Applications", APP_NAME)].find((p) => existsSync(p)) ?? null;
}

async function appVersion(app: string): Promise<string> {
  return (await exec("/usr/bin/defaults", ["read", join(app, "Contents", "Info.plist"), "CFBundleShortVersionString"])).stdout.trim();
}

/** Equipo de la firma de la app, solo si es válida y pasa Gatekeeper (Developer ID notarizado). */
async function trustedTeam(app: string): Promise<string | null> {
  try {
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    await exec("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
    const { stderr } = await exec("/usr/bin/codesign", ["-dv", app]);
    return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Pone al día la app de Mac si hay una versión nueva. Devuelve la versión instalada, o null si no ha hecho nada. */
export async function updateMacApp(opts: { force?: boolean } = {}): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (!opts.force && Date.now() - lastCheck < EVERY_MS) return null;
  lastCheck = Date.now();
  const app = installedApp();
  if (!app) return null;
  const current = await appVersion(app).catch(() => "");
  const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const latest = ((await res.json()) as { tag_name?: string }).tag_name?.replace(/^v/, "");
  if (!latest || !/^\d+\.\d+\.\d+$/.test(latest) || !current || !newer(latest, current) || failed === latest) return null;
  const team = await trustedTeam(app);
  if (!team) return null;

  const work = mkdtempSync(join(tmpdir(), "backcode-app-"));
  const mount = join(work, "mnt");
  let mounted = false;
  try {
    const base = `https://github.com/${RELEASES_REPO}/releases/download/v${latest}`;
    const [dmg, sums] = await Promise.all([
      fetch(`${base}/${DMG}`, { signal: AbortSignal.timeout(10 * 60_000) }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
      fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))),
    ]);
    const expected = new RegExp(`^([0-9a-f]{64})\\s+\\*?${DMG}$`, "m").exec(sums)?.[1];
    const data = Buffer.from(dmg);
    if (!expected || createHash("sha256").update(data).digest("hex") !== expected) throw new Error("sha256");
    const dmgPath = join(work, DMG);
    writeFileSync(dmgPath, data);
    await exec("/usr/bin/hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount]);
    mounted = true;
    const source = readdirSync(mount).find((f) => f === APP_NAME);
    if (!source) throw new Error("no app in dmg");
    // Se copia junto a la instalada (mismo disco: el cambio final es un rename) y se comprueba la copia, no el DMG.
    const next = join(dirname(app), `.${APP_NAME}.${latest}`);
    rmSync(next, { recursive: true, force: true });
    await exec("/usr/bin/ditto", [join(mount, source), next]);
    if ((await trustedTeam(next)) !== team || (await appVersion(next)) !== latest) {
      rmSync(next, { recursive: true, force: true });
      throw new Error("signature");
    }
    const old = join(dirname(app), `.${APP_NAME}.old`);
    rmSync(old, { recursive: true, force: true });
    renameSync(app, old);
    renameSync(next, app);
    rmSync(old, { recursive: true, force: true });
    console.log(`[backcode] Backcode Runner.app ${current} → ${latest}`);
    return latest;
  } catch (err) {
    failed = latest;
    console.warn(`[backcode] Backcode Runner.app: no se pudo actualizar a ${latest} (${(err as Error).message})`);
    return null;
  } finally {
    if (mounted) await exec("/usr/bin/hdiutil", ["detach", mount, "-force"]).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}
