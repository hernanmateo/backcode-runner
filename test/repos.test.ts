import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultClonePath, findProjectRepo, findRepos, normalizeRemote } from "../src/repos.js";

test("remotos: https, ssh y con credenciales apuntan al mismo repo", () => {
  const want = "github.com/acme/storefront";
  for (const url of ["https://github.com/Acme/storefront.git", "git@github.com:acme/storefront.git", "https://user:tok@github.com/acme/storefront", "ssh://git@github.com/acme/storefront.git"]) {
    assert.equal(normalizeRemote(url), want, url);
  }
  assert.equal(normalizeRemote("no es una url"), null);
});

test("carpeta por defecto: nombre del proyecto sin tildes ni espacios", () => {
  assert.match(defaultClonePath("Web de Clientes", "p1"), /Backcode\/web-de-clientes$/);
  assert.match(defaultClonePath(undefined, "p1"), /Backcode\/p1$/);
});

test("encuentra el repo del proyecto en las carpetas habituales (dos niveles)", () => {
  const home = mkdtempSync(join(tmpdir(), "bc-home-"));
  const mk = (rel: string, url: string) => {
    mkdirSync(join(home, rel, ".git"), { recursive: true });
    writeFileSync(join(home, rel, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  };
  mk("Projects/otro", "git@github.com:acme/otro.git");
  mk("Developer/acme/storefront", "git@github.com:acme/storefront.git");
  const repos = findRepos(home);
  assert.equal(repos.length, 2);
  assert.equal(findProjectRepo("https://github.com/acme/storefront.git", repos), join(home, "Developer/acme/storefront"));
  assert.equal(findProjectRepo("https://github.com/acme/nada.git", repos), null);
});
