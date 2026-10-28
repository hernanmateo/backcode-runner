/** En xprem la rama de producción es `prod` (el canal `production` del binario apunta a ella). */
export const SCRIPT_BRANCH: Record<string, string> = { production: "prod", preview: "preview" };

/** Nombres con los que un script `ota:publish` puede llevar ya fijada la rama/canal. */
const BRANCH_TOKENS = new Set([...Object.keys(SCRIPT_BRANCH), ...Object.values(SCRIPT_BRANCH)]);

/** Argumentos posicionales del script (sin valores de flags como `--env production`). */
function positionalTokens(script: string): string[] {
  const tokens = script.split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ""));
  return tokens.filter((t, i) => !t.startsWith("-") && !(tokens[i - 1]?.startsWith("-") ?? false));
}

/**
 * Único punto donde se construye la llamada a `ota:publish`. Si el script del package.json ya lleva la rama
 * (p. ej. `bash scripts/publish-update.sh prod`), no se vuelve a pasar: si no, el script recibe `prod prod` y falla.
 * Si lleva fijada OTRA rama, no se publica (se publicaría en el canal equivocado).
 */
export function otaScriptArgs(
  script: string,
  pm: "npm" | "pnpm" | "yarn" | "bun",
  channel: string,
  message: string,
  allowNative = false,
): { args: string[] } | { error: string; fixed: string } {
  const branch = SCRIPT_BRANCH[channel] ?? channel;
  const fixed = positionalTokens(script).filter((t) => BRANCH_TOKENS.has(t) || t === branch);
  const other = fixed.find((t) => (SCRIPT_BRANCH[t] ?? t) !== branch);
  if (other) return { error: "fixedBranch", fixed: other };
  const extra = fixed.length ? [] : [branch];
  // --yes: la confirmación ya se hizo en la app. Nunca porcentajes; --allow-native solo con «Publicar sin comprobaciones»
  // (allowNative, lo pide un admin a sabiendas y solo si el script lo admite). Si el script se niega, se muestra su motivo.
  return { args: ["run", "ota:publish", ...(pm === "npm" ? ["--"] : []), ...extra, ...(allowNative ? ["--allow-native"] : []), "--yes", "-m", message.slice(0, 200)] };
}
