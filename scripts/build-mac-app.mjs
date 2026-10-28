#!/usr/bin/env node
// «Backcode Runner.app» y Backcode-Runner.dmg (macOS, universal: Apple Silicon e Intel) a partir de los ejecutables de
// dist-bin/ (npm run build:bin -- darwin-arm64 darwin-x64). Solo en un Mac (lipo, iconutil, hdiutil, codesign).
//
// Firma y notarización, si están las variables (en CI vienen de los secretos del repo):
//   MAC_SIGN_IDENTITY   "Developer ID Application: Nombre (TEAMID)" (el certificado ya en el llavero)
//   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   para notarytool (contraseña de aplicación del Apple ID)
// Sin ellas, la app sale sin firmar: sirve para probarla en tu Mac (clic derecho → Abrir), no para distribuirla.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bin");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const identity = process.env.MAC_SIGN_IDENTITY;

for (const arch of ["arm64", "x64"]) {
  if (!existsSync(join(out, `backcode-darwin-${arch}`))) throw new Error(`falta dist-bin/backcode-darwin-${arch}: npm run build:bin -- darwin-arm64 darwin-x64`);
}

// Firma de un Mach-O con hardened runtime (requisito de la notarización) y los permisos de JIT de Bun.
const sign = (path) => identity && run("codesign", ["--force", "--timestamp", "--options", "runtime", "--entitlements", join(root, "mac", "entitlements.plist"), "--sign", identity, path]);

// Los sueltos (install.sh y la actualización automática) también se firman si hay identidad.
for (const arch of ["arm64", "x64"]) sign(join(out, `backcode-darwin-${arch}`));

const app = join(out, "Backcode Runner.app");
rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
run("lipo", ["-create", join(out, "backcode-darwin-arm64"), join(out, "backcode-darwin-x64"), "-output", join(app, "Contents", "MacOS", "Backcode Runner")]);

// Icono: el de la app de Backcode en todos los tamaños de un .icns.
const iconset = join(out, "Backcode.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    run("sips", ["-z", String(px), String(px), join(root, "mac", "icon-1024.png"), "--out", join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "ignore" });
  }
}
run("iconutil", ["-c", "icns", iconset, "-o", join(app, "Contents", "Resources", "Backcode.icns")]);
rmSync(iconset, { recursive: true, force: true });

writeFileSync(
  join(app, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Backcode Runner</string>
  <key>CFBundleDisplayName</key><string>Backcode Runner</string>
  <key>CFBundleIdentifier</key><string>com.backcode.runner</string>
  <key>CFBundleExecutable</key><string>Backcode Runner</string>
  <key>CFBundleIconFile</key><string>Backcode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <!-- Sin icono en el Dock: abre el panel en el navegador y termina; el runner sigue como servicio. -->
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>© Hernan Mateo · Apache-2.0</string>
</dict>
</plist>
`,
);
sign(join(app, "Contents", "MacOS", "Backcode Runner"));
if (identity) run("codesign", ["--force", "--timestamp", "--options", "runtime", "--entitlements", join(root, "mac", "entitlements.plist"), "--sign", identity, app]);

// .dmg con el atajo a Aplicaciones para arrastrar.
const stage = join(out, "dmg");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
cpSync(app, join(stage, "Backcode Runner.app"), { recursive: true, verbatimSymlinks: true });
symlinkSync("/Applications", join(stage, "Applications"));
const dmg = join(out, "Backcode-Runner.dmg");
rmSync(dmg, { force: true });
run("hdiutil", ["create", "-volname", "Backcode Runner", "-srcfolder", stage, "-ov", "-format", "UDZO", "-fs", "HFS+", dmg]);
rmSync(stage, { recursive: true, force: true });
if (identity) run("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);

if (identity && process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_PASSWORD) {
  run("xcrun", ["notarytool", "submit", dmg, "--apple-id", process.env.APPLE_ID, "--team-id", process.env.APPLE_TEAM_ID, "--password", process.env.APPLE_APP_PASSWORD, "--wait"]);
  run("xcrun", ["stapler", "staple", dmg]);
  console.log("✓ firmada y notarizada");
} else if (identity) {
  console.log("⚠ firmada pero sin notarizar (faltan APPLE_ID, APPLE_TEAM_ID o APPLE_APP_PASSWORD)");
} else {
  console.log("⚠ sin firmar (falta MAC_SIGN_IDENTITY): solo para probar en este Mac");
}
console.log(`✓ ${app}\n✓ ${dmg}`);
