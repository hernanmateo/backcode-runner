// Cambios nativos de una app Expo: los que una OTA no puede llevar y piden una build nueva. Por plataforma: `ios/` solo
// afecta a iOS y `android/` solo a Android; la config de Expo, eas.json, plugins/módulos propios y las dependencias con
// código nativo, a las dos. Sin git ni Firebase (se prueba con listas de ficheros).

export type BuildPlatform = "ios" | "android";
export const BUILD_PLATFORMS: BuildPlatform[] = ["ios", "android"];

const BOTH = /^(app\.json|app\.config\.[cm]?[jt]s|eas\.json)$|^(plugins|modules)\//;

/** Dependencias que traen código nativo (o fijan el SDK de Expo): cambiarlas cambia el binario. */
export function isNativeDependency(name: string): boolean {
  return name === "expo" || name.startsWith("expo-") || /(^|[/-])react-native($|-)/.test(name) || name.startsWith("@react-native");
}

type Pkg = { dependencies?: Record<string, string> };

/** Dependencias nativas añadidas, quitadas o con otra versión entre dos package.json (texto; inválido = sin dependencias). */
export function nativeDependencyChanges(before: string, after: string): string[] {
  const deps = (text: string) => {
    try {
      return (JSON.parse(text) as Pkg).dependencies ?? {};
    } catch {
      return {};
    }
  };
  const a = deps(before);
  const b = deps(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((n) => isNativeDependency(n) && a[n] !== b[n]).sort();
}

/**
 * Qué ficheros cambiados (rutas del repo) son nativos para cada plataforma. `appDir` es la carpeta de la app ("" si está
 * en la raíz); `packageChanged` dice si el package.json de la app cambió dependencias nativas (ver nativeDependencyChanges).
 */
export function nativeFilesByPlatform(files: string[], appDir: string, packageChanged = false): Record<BuildPlatform, string[]> {
  const prefix = appDir ? `${appDir.replace(/\/$/, "")}/` : "";
  const out: Record<BuildPlatform, string[]> = { ios: [], android: [] };
  for (const f of files) {
    if (prefix && !f.startsWith(prefix)) continue;
    const rel = f.slice(prefix.length);
    if (/(^|\/)node_modules\//.test(rel)) continue;
    if (rel.startsWith("ios/")) out.ios.push(f);
    else if (rel.startsWith("android/")) out.android.push(f);
    else if (BOTH.test(rel) || (rel === "package.json" && packageChanged)) for (const p of BUILD_PLATFORMS) out[p].push(f);
  }
  return out;
}
