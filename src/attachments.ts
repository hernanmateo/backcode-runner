import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { excludeFromGit } from "./git.js";
import { t } from "./i18n.js";
import type { Attachment, Store } from "./store.js";

// Los adjuntos de la tarea (capturas, PDFs…) se descargan dentro del worktree para que Claude los pueda
// leer con Read sin salir de él. La carpeta está excluida de git y protegida: nunca acaba en el PR.

export const ATTACHMENTS_DIR = ".backcode-attachments";

export interface LocalAttachment {
  file: string; // ruta relativa al worktree
  name: string;
  contentType: string;
}

export async function materializeAttachments(store: Store, projectId: string, worktree: string, attachments: Attachment[]): Promise<LocalAttachment[]> {
  if (!attachments.length) return [];
  await excludeFromGit(worktree, `/${ATTACHMENTS_DIR}/`);
  const dir = join(worktree, ATTACHMENTS_DIR);
  mkdirSync(dir, { recursive: true });
  const out: LocalAttachment[] = [];
  for (const [i, a] of attachments.slice(0, 10).entries()) {
    // Mismas restricciones que en las Functions: solo rutas de adjuntos de este proyecto.
    const m = new RegExp(`^projects/${projectId}/attachments/[A-Za-z0-9]+/([A-Za-z0-9._-]{1,120})$`).exec(a.path);
    if (!m) throw new Error(t("att.badPath", { path: a.path }));
    const file = `${ATTACHMENTS_DIR}/${i + 1}-${m[1].replace(/^\d+-[a-z0-9]+-/, "")}`;
    const abs = join(worktree, file);
    if (!existsSync(abs)) writeFileSync(abs, await store.download(a.path));
    out.push({ file, name: a.name, contentType: a.contentType });
  }
  return out;
}
