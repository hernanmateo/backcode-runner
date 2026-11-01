// ¿Tiene CI el repo? Sin CI, los PR y la rama base no tienen checks y requireGreen (actions.ts) deja mergear y desplegar
// sin comprobar nada: la app lo avisa (badge «Sin CI», al mergear y al publicar) con lo que anuncia el runner aquí.
import { git } from "./git.js";
import type { PrHost } from "./hosts.js";

/** Ficheros de configuración de CI conocidos (en la raíz del repo). */
const CI_FILES = [/^\.github\/workflows\/[^/]+\.ya?ml$/, /^bitbucket-pipelines\.yml$/, /^\.gitlab-ci\.yml$/, /^\.circleci\/config\.ya?ml$/, /^azure-pipelines\.ya?ml$/, /^Jenkinsfile$/, /^\.buildkite\//, /^\.woodpecker(\.ya?ml|\/)/, /^\.drone\.ya?ml$/];

export function hasCiConfig(paths: string[]): boolean {
  return paths.some((p) => CI_FILES.some((re) => re.test(p)));
}

/** true si `ref` (un commit o una rama remota) tiene un fichero de CI; false si no o si no se pudo leer. */
export async function ciConfigAt(repoPath: string, ref: string): Promise<boolean> {
  const files = await git(repoPath, ["ls-tree", "-r", "--name-only", ref]).catch(() => null);
  return !!files && hasCiConfig(files.split("\n"));
}

/**
 * true si la rama base tiene CI: un fichero de CI en `commit` o, si no (integraciones sin fichero: Vercel, Netlify,
 * una GitHub App…), algún check en ese commit. null si no se pudo saber.
 */
export async function detectCi(repoPath: string, commit: string, host: PrHost | undefined): Promise<boolean | null> {
  const files = await git(repoPath, ["ls-tree", "-r", "--name-only", commit]).catch(() => null);
  if (files && hasCiConfig(files.split("\n"))) return true;
  if (!host) return files ? false : null;
  const checks = await host.commitChecks(commit).catch(() => null);
  return checks ? checks.state !== "none" : files ? false : null;
}
