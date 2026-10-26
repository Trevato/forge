/**
 * A repository's code page lays main and its About rail with `.split`, the
 * one two-column page; `.repo-layout` is gone (#4592).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-repo-layout-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "olive",
    email: "olive@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const r = await createRepo(app, made.value, { name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const c = await commitFiles(repoDir(app.reposRoot, "olive", "yard"), {
    branch: "main",
    message: "first",
    files: [{ path: "README.md", content: "# yard\n" }],
    author: { name: "olive", email: "olive@forge.local" },
  });
  if (!c.ok) throw new Error("no commit");
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("the code page wraps main and the About aside in .split, not .repo-layout", async () => {
  const r = await fetch(`${servers.url}/olive/yard`);
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).not.toContain("repo-layout");
  expect(html).toMatch(/<div class="split">\s*<div>[\s\S]*<\/div>\s*<aside aria-label="About">/);
});
