import { isTransientRemoteError, withRemoteRetry } from "./remote-retry.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { t } from "./i18n.js";

// Alojamiento del repo para PRs, checks y merge. Lo usa solo el runner (nunca Claude): las
// credenciales son las del usuario (sesión de `gh` o API token de Bitbucket en su .env).

const run = promisify(execFile);

export type ChecksState = "green" | "pending" | "failing" | "none";
export interface Checks {
  state: ChecksState;
  /** Checks que no están en verde (nombre: estado), para explicarlo en la app. */
  pending: string[];
}

/** Un check de un commit: nombre y estado. */
export interface CheckItem {
  name: string;
  state: "ok" | "pending" | "fail";
}

/** Estado que publica el runner en un commit (los checks locales: local-checks.ts). */
export interface CommitStatus {
  name: string;
  state: "ok" | "pending" | "fail";
  /** Frase corta (GitHub admite 140 caracteres). */
  description: string;
}

export interface PrHost {
  kind: "github" | "bitbucket";
  /** Abre el PR en borrador o devuelve el abierto de esa rama (el push ya lo actualizó). */
  openOrUpdatePr(o: { cwd: string; branch: string; base: string; title: string; body: string }): Promise<string>;
  prChecks(prUrl: string): Promise<Checks>;
  commitChecks(sha: string): Promise<Checks>;
  /** Los checks de un commit uno a uno (los locales que ya pasaron no se repiten). */
  commitItems?(sha: string): Promise<CheckItem[]>;
  /** Publica un estado en el commit («Backcode · …»): sale en el PR como un check más. */
  setStatus?(sha: string, status: CommitStatus): Promise<void>;
  /**
   * Checks en rojo del PR que no llegaron a ejecutarse (GitHub Actions sin minutos o con un pago fallido): sus nombres.
   * Solo GitHub; ausente si el host no lo sabe.
   */
  notStarted?(prUrl: string): Promise<string[]>;
  /** Lo mismo en un commit (la rama base antes de un despliegue, OTA o build). */
  commitNotStarted?(sha: string): Promise<string[]>;
  /** Vuelve a lanzar los jobs en rojo del PR (GitHub Actions) y devuelve cuántos runs relanzó; ausente si el host no puede. */
  rerunFailed?(prUrl: string): Promise<number>;
  /** Log en bruto de los checks que fallan del PR (GitHub Actions); ausente si el host no lo da. Ver check-logs.ts. */
  failedLog?(prUrl: string): Promise<string>;
  /**
   * Saca el PR de borrador, lo mergea (por defecto con squash y borrando la rama) y devuelve el commit resultante si se
   * conoce. La PR de promoción (rama de preview → base) va con merge commit y sin borrar la rama: ver mergeOptions.
   */
  merge(prUrl: string, opts?: MergeOptions): Promise<{ sha?: string }>;
  /** Estado del PR (p. ej. para enterarse de un merge hecho a mano en GitHub/Bitbucket) y su commit de merge. */
  prState(prUrl: string): Promise<{ state: "open" | "merged" | "closed"; sha?: string }>;
  /** El último commit de la rama del PR según el host (para saber que ya vio un push); ausente si no lo da. */
  prHeadSha?(prUrl: string): Promise<string>;
  /** PR abiertos del repo (también los creados fuera de Backcode), los más recientes primero. */
  listOpen(): Promise<OpenPr[]>;
  /** Los últimos PR mergeados del repo (los más recientes primero) en una sola consulta: ver merged-watch.ts. */
  recentlyMerged?(): Promise<{ url: string; sha?: string }[]>;
  /** Cierra el PR sin mergear; con `deleteBranch`, borra también su rama del remoto. */
  close(prUrl: string, deleteBranch: boolean): Promise<void>;
  /** Deja un comentario en el PR (p. ej. el resultado del code review automático); ausente si el host no lo admite. */
  comment?(prUrl: string, body: string): Promise<void>;
}

export interface OpenPr {
  url: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  updatedAt: string;
}

export const summarize = (items: CheckItem[]): Checks => {
  if (!items.length) return { state: "none", pending: [] };
  const bad = items.filter((i) => i.state !== "ok");
  return {
    state: items.some((i) => i.state === "fail") ? "failing" : bad.length ? "pending" : "green",
    pending: bad.map((i) => `${i.name}: ${i.state}`).slice(0, 10),
  };
};

// --- GitHub (gh CLI) ----------------------------------------------------------------

/** Fallos de GitHub que no dependen del PR (p. ej. "GraphQL: Something went wrong…" justo tras sacarlo de borrador, 5xx, timeouts). */
export function isTransientGhError(e: unknown): boolean {
  return isTransientRemoteError(e);
}

/** El PR choca con la rama base (GitHub: "not mergeable: the merge commit cannot be cleanly created"; Bitbucket: "merge conflicts"). */
export function isMergeConflictError(e: unknown): boolean {
  const text = `${(e as { stderr?: unknown })?.stderr ?? ""}\n${(e as Error)?.message ?? e}`;
  return /not mergeable|cannot be cleanly created|merge conflicts?|conflicts? (with|in) the (base|destination)/i.test(text);
}

/**
 * Mergea reintentando los fallos transitorios de GitHub. Si el merge falla pero el PR ya consta como mergeado
 * (--delete-branch no puede borrar la rama local de un worktree, o GitHub mergeó pese al error), se da por bueno.
 */
export async function mergeWithRetry(merge: () => Promise<unknown>, state: () => Promise<string>, delaysMs = [5_000, 15_000, 30_000, 60_000]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await merge();
      return;
    } catch (e) {
      if ((await state()) === "MERGED") return;
      if (attempt >= delaysMs.length || !isTransientGhError(e)) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

/**
 * Aviso de GitHub en un job que no llegó a arrancar por la facturación de Actions («The job was not started because recent
 * account payments have failed or your spending limit needs to be increased…»).
 */
export const NOT_STARTED_RE = /job was not started|spending limit needs|payments? (?:have|has) failed|billing & plans/i;

const GH_STATE = { ok: "success", pending: "pending", fail: "failure" } as const;
const BB_STATE = { ok: "SUCCESSFUL", pending: "INPROGRESS", fail: "FAILED" } as const;

export function githubHost(repoPath: string): PrHost {
  const gh = async (args: string[], cwd = repoPath) => (await run("gh", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout.trim();
  let repoName: Promise<string> | undefined;
  const repo = () => (repoName ??= gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).catch((e) => {
    repoName = undefined;
    throw e;
  }));
  const commitItems = async (sha: string): Promise<CheckItem[]> => {
    const name = await repo();
    const runs = JSON.parse(await gh(["api", `repos/${name}/commits/${sha}/check-runs`, "--paginate"])) as { check_runs: { name: string; status: string; conclusion: string | null }[] };
    const statuses = JSON.parse(await gh(["api", `repos/${name}/commits/${sha}/status`])) as { statuses: { context: string; state: string }[] };
    return [
      ...runs.check_runs.filter((r) => r.conclusion !== "skipped" && r.conclusion !== "neutral").map((r) => ({ name: r.name, state: (r.status !== "completed" ? "pending" : r.conclusion === "success" ? "ok" : "fail") as CheckItem["state"] })),
      ...statuses.statuses.map((s) => ({ name: s.context, state: (s.state === "success" ? "ok" : s.state === "pending" ? "pending" : "fail") as CheckItem["state"] })),
    ];
  };
  return {
    kind: "github",
    openOrUpdatePr({ cwd, branch, base, title, body }) {
      // Con reintentos ante caídas de GitHub: si el PR llegó a crearse pese al error, el siguiente intento lo encuentra.
      return withRemoteRetry(async () => {
      // El abierto de la rama, o uno ya mergeado (p. ej. a mano en GitHub): no se crea otro.
      const existing = await gh(["pr", "view", branch, "--json", "url,state", "-q", 'select(.state == "OPEN" or .state == "MERGED") | .url'], cwd).catch(() => "");
      if (/^https:\/\//.test(existing)) return existing;
      const out = await gh(["pr", "create", "--draft", "--base", base, "--head", branch, "--title", title, "--body", body], cwd);
      const url = out.split("\n").pop() ?? "";
      if (!/^https:\/\//.test(url)) throw new Error(t("host.ghNoUrl", { out }));
      return url;
      }, { label: "gh pr create" });
    },
    async prChecks(prUrl) {
      // Sin checks configurados, gh sale con error "no checks reported": se trata como "none".
      const out = await gh(["pr", "checks", prUrl, "--json", "name,bucket"]).catch((e) => (/no checks/i.test(String(e?.stderr ?? e)) ? "[]" : Promise.reject(e)));
      const rows = JSON.parse(out || "[]") as { name: string; bucket: string }[];
      return summarize(rows.filter((r) => r.bucket !== "skipping").map((r) => ({ name: r.name, state: r.bucket === "pass" ? "ok" : r.bucket === "pending" ? "pending" : "fail" })));
    },
    async failedLog(prUrl) {
      // Los checks de GitHub Actions enlazan a .../actions/runs/<run>/job/<job>: el log de los jobs fallidos de cada run
      // (como mucho 3, los demás suelen repetir el mismo error).
      const rows = JSON.parse(await gh(["pr", "checks", prUrl, "--json", "bucket,link"]).catch(() => "[]") || "[]") as { bucket: string; link?: string }[];
      const runs = [...new Set(rows.filter((r) => r.bucket === "fail").map((r) => /\/actions\/runs\/(\d+)/.exec(r.link ?? "")?.[1]).filter((id): id is string => !!id))].slice(0, 3);
      const logs = await Promise.all(runs.map((id) => gh(["run", "view", id, "--log-failed"]).catch(() => "")));
      return logs.filter(Boolean).join("\n");
    },
    async commitChecks(sha) {
      return summarize(await commitItems(sha));
    },
    commitItems,
    async setStatus(sha, st) {
      await gh(["api", "-X", "POST", `repos/${await repo()}/statuses/${sha}`, "-f", `state=${GH_STATE[st.state]}`, "-f", `context=${st.name}`, "-f", `description=${st.description.slice(0, 140)}`]);
    },
    async rerunFailed(prUrl) {
      const rows = JSON.parse((await gh(["pr", "checks", prUrl, "--json", "bucket,link"]).catch(() => "[]")) || "[]") as { bucket: string; link?: string }[];
      const runs = [...new Set(rows.filter((r) => r.bucket === "fail").map((r) => /\/actions\/runs\/(\d+)/.exec(r.link ?? "")?.[1]).filter((id): id is string => !!id))];
      for (const id of runs) await gh(["run", "rerun", id, "--failed"]);
      return runs.length;
    },
    async commitNotStarted(sha) {
      const name = await repo();
      const runs = JSON.parse(await gh(["api", `repos/${name}/commits/${sha}/check-runs`, "--paginate"])) as { check_runs: { id: number; name: string; status: string; conclusion: string | null }[] };
      const out: string[] = [];
      for (const r of runs.check_runs.filter((x) => x.status === "completed" && x.conclusion === "failure").slice(0, 10)) {
        const notes = JSON.parse((await gh(["api", `repos/${name}/check-runs/${r.id}/annotations`]).catch(() => "[]")) || "[]") as { message?: string }[];
        if (notes.some((n) => NOT_STARTED_RE.test(n.message ?? ""))) out.push(r.name);
      }
      return out;
    },
    async notStarted(prUrl) {
      // Los jobs que no arrancaron no tienen log: solo una anotación de GitHub que explica por qué.
      const rows = JSON.parse((await gh(["pr", "checks", prUrl, "--json", "name,bucket,link"]).catch(() => "[]")) || "[]") as { name: string; bucket: string; link?: string }[];
      const failing = rows.filter((r) => r.bucket === "fail").slice(0, 10);
      if (!failing.length) return [];
      const name = await repo();
      const out: string[] = [];
      for (const r of failing) {
        const id = /\/job\/(\d+)/.exec(r.link ?? "")?.[1];
        if (!id) continue;
        const notes = JSON.parse((await gh(["api", `repos/${name}/check-runs/${id}/annotations`]).catch(() => "[]")) || "[]") as { message?: string }[];
        if (notes.some((n) => NOT_STARTED_RE.test(n.message ?? ""))) out.push(r.name);
      }
      return out;
    },
    async merge(prUrl, opts) {
      // Sacarlo de borrador. Con GitHub caído, `gh pr ready` puede fallar: antes se ignoraba y el merge fallaba luego con
      // «Pull Request is still a draft». Ahora se reintenta hasta que consta como no borrador (si ya no lo era, da igual).
      const isDraft = async () => (await gh(["pr", "view", prUrl, "--json", "isDraft", "-q", ".isDraft"])) === "true";
      await withRemoteRetry(
        async () => {
          await gh(["pr", "ready", prUrl]).catch(() => undefined);
          if (await isDraft()) throw new Error("Pull Request is still a draft (gh pr ready no ha llegado a aplicarse)");
        },
        { label: "gh pr ready" },
      );
      await mergeWithRetry(
        () => gh(ghMergeArgs(prUrl, opts)),
        () => gh(["pr", "view", prUrl, "--json", "state", "-q", ".state"]).catch(() => ""),
      );
      const sha = await gh(["pr", "view", prUrl, "--json", "mergeCommit", "-q", ".mergeCommit.oid"]).catch(() => "");
      return { sha: sha || undefined };
    },
    async prHeadSha(prUrl) {
      return (await gh(["pr", "view", prUrl, "--json", "headRefOid", "-q", ".headRefOid"])).trim();
    },
    async prState(prUrl) {
      const pr = JSON.parse(await gh(["pr", "view", prUrl, "--json", "state,mergeCommit"])) as { state: string; mergeCommit?: { oid?: string } | null };
      return { state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open", sha: pr.mergeCommit?.oid || undefined };
    },
    async listOpen() {
      const rows = JSON.parse(await gh(["pr", "list", "--state", "open", "--limit", "50", "--json", "url,number,title,author,headRefName,baseRefName,isDraft,updatedAt"])) as {
        url: string; number: number; title: string; author?: { login?: string }; headRefName: string; baseRefName: string; isDraft: boolean; updatedAt: string;
      }[];
      return rows.map((r) => ({ url: r.url, number: r.number, title: r.title, author: r.author?.login ?? "", branch: r.headRefName, base: r.baseRefName, draft: r.isDraft, updatedAt: r.updatedAt }));
    },
    async recentlyMerged() {
      const rows = JSON.parse(await gh(["pr", "list", "--state", "merged", "--limit", "30", "--json", "url,mergeCommit"])) as { url: string; mergeCommit?: { oid?: string } | null }[];
      return rows.map((r) => ({ url: r.url, sha: r.mergeCommit?.oid || undefined }));
    },
    async close(prUrl, deleteBranch) {
      await gh(["pr", "close", prUrl, ...(deleteBranch ? ["--delete-branch"] : [])]).catch(async (e) => {
        // --delete-branch puede fallar con la rama local en un worktree tras cerrar bien.
        const state = await gh(["pr", "view", prUrl, "--json", "state", "-q", ".state"]).catch(() => "");
        if (state !== "CLOSED") throw e;
      });
    },
    async comment(prUrl, body) {
      await gh(["pr", "comment", prUrl, "--body", body]);
    },
  };
}

// --- Bitbucket Cloud (API REST 2.0 con API token) -----------------------------------

/** workspace/repo a partir de la URL del remoto (https://…@bitbucket.org/ws/repo.git o git@bitbucket.org:ws/repo.git). */
export function bitbucketRepo(remoteUrl: string): { workspace: string; slug: string } | null {
  const m = /bitbucket\.org[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(remoteUrl);
  return m ? { workspace: m[1], slug: m[2] } : null;
}

export function bitbucketHost(remoteUrl: string, email: string, token: string): PrHost {
  const repo = bitbucketRepo(remoteUrl);
  if (!repo) throw new Error(t("host.bbRepo", { url: remoteUrl }));
  const base = `https://api.bitbucket.org/2.0/repositories/${repo.workspace}/${repo.slug}`;
  // Los API tokens de Atlassian van con el email de la cuenta (con el usuario da 401).
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: auth, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitbucket ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
  const prId = (url: string) => /pull-requests\/(\d+)/.exec(url)?.[1] ?? Promise.reject(new Error(t("host.badPrUrl", { url })));
  type Pr = { id: number; links: { html: { href: string } }; merge_commit?: { hash: string } };
  const toChecks = (values: { name?: string; key: string; state: string }[]) =>
    summarize(values.map((v) => ({ name: v.name ?? v.key, state: v.state === "SUCCESSFUL" ? "ok" : v.state === "INPROGRESS" ? "pending" : "fail" })));

  return {
    kind: "bitbucket",
    async openOrUpdatePr({ branch, base: dest, title, body }) {
      // El abierto de la rama, o uno ya mergeado (p. ej. a mano en Bitbucket): no se crea otro.
      const q = encodeURIComponent(`source.branch.name="${branch}" AND (state="OPEN" OR state="MERGED")`);
      const open = await api<{ values: Pr[] }>(`/pullrequests?q=${q}`);
      if (open.values[0]) return open.values[0].links.html.href;
      const payload = { title, description: body, source: { branch: { name: branch } }, destination: { branch: { name: dest } }, close_source_branch: true };
      // Borrador si el workspace lo admite; si no, se abre normal.
      const pr = await api<Pr>("/pullrequests", { method: "POST", body: { ...payload, draft: true } }).catch(() => api<Pr>("/pullrequests", { method: "POST", body: payload }));
      return pr.links.html.href;
    },
    async prChecks(prUrl) {
      const id = await prId(prUrl);
      return toChecks((await api<{ values: { name?: string; key: string; state: string }[] }>(`/pullrequests/${id}/statuses?pagelen=50`)).values);
    },
    async commitChecks(sha) {
      return toChecks((await api<{ values: { name?: string; key: string; state: string }[] }>(`/commit/${sha}/statuses?pagelen=50`)).values);
    },
    async commitItems(sha) {
      const values = (await api<{ values: { name?: string; key: string; state: string }[] }>(`/commit/${sha}/statuses?pagelen=50`)).values;
      return values.map((v) => ({ name: v.name ?? v.key, state: v.state === "SUCCESSFUL" ? "ok" : v.state === "INPROGRESS" ? "pending" : "fail" }));
    },
    async setStatus(sha, st) {
      // La clave identifica el estado (se reemplaza al volver a publicarlo); la URL es obligatoria en Bitbucket.
      const key = `backcode-${st.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`.slice(0, 40);
      const url = `https://bitbucket.org/${repo.workspace}/${repo.slug}/commits/${sha}`;
      await api(`/commit/${sha}/statuses/build`, { method: "POST", body: { key, state: BB_STATE[st.state], name: st.name, description: st.description.slice(0, 140), url } });
    },
    async merge(prUrl, opts) {
      const id = await prId(prUrl);
      await api(`/pullrequests/${id}`, { method: "PUT", body: { draft: false } }).catch(() => undefined);
      const pr = await api<Pr>(`/pullrequests/${id}/merge`, { method: "POST", body: bitbucketMergeBody(opts) });
      return { sha: pr.merge_commit?.hash };
    },
    async prHeadSha(prUrl) {
      const pr = await api<Pr & { source?: { commit?: { hash?: string } } }>(`/pullrequests/${await prId(prUrl)}`);
      return pr.source?.commit?.hash ?? "";
    },
    async prState(prUrl) {
      const pr = await api<Pr & { state: string }>(`/pullrequests/${await prId(prUrl)}`);
      return { state: pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed", sha: pr.merge_commit?.hash };
    },
    async listOpen() {
      type Row = Pr & { title: string; author?: { display_name?: string }; source: { branch: { name: string } }; destination: { branch: { name: string } }; draft?: boolean; updated_on: string };
      const rows = (await api<{ values: Row[] }>(`/pullrequests?state=OPEN&pagelen=50`)).values;
      return rows.map((r) => ({ url: r.links.html.href, number: r.id, title: r.title, author: r.author?.display_name ?? "", branch: r.source.branch.name, base: r.destination.branch.name, draft: !!r.draft, updatedAt: r.updated_on }));
    },
    async recentlyMerged() {
      const rows = (await api<{ values: Pr[] }>(`/pullrequests?state=MERGED&pagelen=30&sort=-updated_on`)).values;
      return rows.map((r) => ({ url: r.links.html.href, sha: r.merge_commit?.hash }));
    },
    async close(prUrl, deleteBranch) {
      const id = await prId(prUrl);
      const pr = await api<{ source: { branch: { name: string } } }>(`/pullrequests/${id}`);
      await api(`/pullrequests/${id}/decline`, { method: "POST" });
      if (deleteBranch) await api(`/refs/branches/${encodeURIComponent(pr.source.branch.name)}`, { method: "DELETE" }).catch(() => undefined);
    },
  };
}

/** Cómo se mergea un PR: squash y borrar la rama (las tareas) o merge commit conservando la rama (la promoción). */
export interface MergeOptions {
  method?: "squash" | "merge";
  deleteBranch?: boolean;
}

/** Argumentos de `gh pr merge`. */
export function ghMergeArgs(prUrl: string, opts: MergeOptions = {}): string[] {
  return ["pr", "merge", prUrl, opts.method === "merge" ? "--merge" : "--squash", ...(opts.deleteBranch === false ? [] : ["--delete-branch"])];
}

/** Cuerpo del merge de Bitbucket. */
export function bitbucketMergeBody(opts: MergeOptions = {}): { merge_strategy: "squash" | "merge_commit"; close_source_branch: boolean } {
  return { merge_strategy: opts.method === "merge" ? "merge_commit" : "squash", close_source_branch: opts.deleteBranch !== false };
}
