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

export interface PrHost {
  kind: "github" | "bitbucket";
  /** Abre el PR en borrador o devuelve el abierto de esa rama (el push ya lo actualizó). */
  openOrUpdatePr(o: { cwd: string; branch: string; base: string; title: string; body: string }): Promise<string>;
  prChecks(prUrl: string): Promise<Checks>;
  commitChecks(sha: string): Promise<Checks>;
  /** Log en bruto de los checks que fallan del PR (GitHub Actions); ausente si el host no lo da. Ver check-logs.ts. */
  failedLog?(prUrl: string): Promise<string>;
  /** Saca el PR de borrador, lo mergea con squash y borra la rama. Devuelve el commit resultante si se conoce. */
  merge(prUrl: string): Promise<{ sha?: string }>;
  /** Estado del PR (p. ej. para enterarse de un merge hecho a mano en GitHub/Bitbucket) y su commit de merge. */
  prState(prUrl: string): Promise<{ state: "open" | "merged" | "closed"; sha?: string }>;
  /** PR abiertos del repo (también los creados fuera de Backcode), los más recientes primero. */
  listOpen(): Promise<OpenPr[]>;
  /** Cierra el PR sin mergear; con `deleteBranch`, borra también su rama del remoto. */
  close(prUrl: string, deleteBranch: boolean): Promise<void>;
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

const summarize = (items: { name: string; state: "ok" | "pending" | "fail" }[]): Checks => {
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
  const text = `${(e as { stderr?: unknown })?.stderr ?? ""}\n${(e as Error)?.message ?? e}`;
  return /something went wrong|\b50[234]\b|bad gateway|service unavailable|gateway time-?out|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|try again later/i.test(text);
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
export async function mergeWithRetry(merge: () => Promise<unknown>, state: () => Promise<string>, delaysMs = [3000, 10000]): Promise<void> {
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

export function githubHost(repoPath: string): PrHost {
  const gh = async (args: string[], cwd = repoPath) => (await run("gh", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout.trim();
  return {
    kind: "github",
    async openOrUpdatePr({ cwd, branch, base, title, body }) {
      // El abierto de la rama, o uno ya mergeado (p. ej. a mano en GitHub): no se crea otro.
      const existing = await gh(["pr", "view", branch, "--json", "url,state", "-q", 'select(.state == "OPEN" or .state == "MERGED") | .url'], cwd).catch(() => "");
      if (/^https:\/\//.test(existing)) return existing;
      const out = await gh(["pr", "create", "--draft", "--base", base, "--head", branch, "--title", title, "--body", body], cwd);
      const url = out.split("\n").pop() ?? "";
      if (!/^https:\/\//.test(url)) throw new Error(t("host.ghNoUrl", { out }));
      return url;
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
      const repo = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
      const runs = JSON.parse(await gh(["api", `repos/${repo}/commits/${sha}/check-runs`, "--paginate"])) as { check_runs: { name: string; status: string; conclusion: string | null }[] };
      const statuses = JSON.parse(await gh(["api", `repos/${repo}/commits/${sha}/status`])) as { statuses: { context: string; state: string }[] };
      return summarize([
        ...runs.check_runs.filter((r) => r.conclusion !== "skipped" && r.conclusion !== "neutral").map((r) => ({ name: r.name, state: (r.status !== "completed" ? "pending" : r.conclusion === "success" ? "ok" : "fail") as "ok" | "pending" | "fail" })),
        ...statuses.statuses.map((s) => ({ name: s.context, state: (s.state === "success" ? "ok" : s.state === "pending" ? "pending" : "fail") as "ok" | "pending" | "fail" })),
      ]);
    },
    async merge(prUrl) {
      await gh(["pr", "ready", prUrl]).catch(() => undefined); // si ya no era borrador, da igual
      await mergeWithRetry(
        () => gh(["pr", "merge", prUrl, "--squash", "--delete-branch"]),
        () => gh(["pr", "view", prUrl, "--json", "state", "-q", ".state"]).catch(() => ""),
      );
      const sha = await gh(["pr", "view", prUrl, "--json", "mergeCommit", "-q", ".mergeCommit.oid"]).catch(() => "");
      return { sha: sha || undefined };
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
    async close(prUrl, deleteBranch) {
      await gh(["pr", "close", prUrl, ...(deleteBranch ? ["--delete-branch"] : [])]).catch(async (e) => {
        // --delete-branch puede fallar con la rama local en un worktree tras cerrar bien.
        const state = await gh(["pr", "view", prUrl, "--json", "state", "-q", ".state"]).catch(() => "");
        if (state !== "CLOSED") throw e;
      });
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
    async merge(prUrl) {
      const id = await prId(prUrl);
      await api(`/pullrequests/${id}`, { method: "PUT", body: { draft: false } }).catch(() => undefined);
      const pr = await api<Pr>(`/pullrequests/${id}/merge`, { method: "POST", body: { merge_strategy: "squash", close_source_branch: true } });
      return { sha: pr.merge_commit?.hash };
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
    async close(prUrl, deleteBranch) {
      const id = await prId(prUrl);
      const pr = await api<{ source: { branch: { name: string } } }>(`/pullrequests/${id}`);
      await api(`/pullrequests/${id}/decline`, { method: "POST" });
      if (deleteBranch) await api(`/refs/branches/${encodeURIComponent(pr.source.branch.name)}`, { method: "DELETE" }).catch(() => undefined);
    },
  };
}
