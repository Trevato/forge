/**
 * A repository's About column is §5's card, not `.about` (#4144): the old
 * name is gone from the markup, and every word, link and form stays.
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-about-card-"));
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
  const r = await createRepo(app, made.value, {
    name: "yard",
    visibility: "public",
    description: "a small yard",
  });
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

test("the About column is a settings block with stacked `dl` facts and no .about", async () => {
  const r = await fetch(`${servers.url}/olive/yard`);
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).not.toMatch(/class="[^"]*\babout\b/);
  const rail = html.match(/<aside[^>]*>[\s\S]*?<\/aside>/)?.[0] ?? "";
  expect(rail).toContain('class="settings-block"');
  expect(rail).toContain('<dl class="rail-facts">');
  expect(rail).toContain('<div class="rail-fact"><dt>Visibility</dt>');
  expect(rail).not.toContain("status-row");
  expect(rail).not.toContain('class="card"');
  expect(rail).toContain("<h2>About</h2>");
  expect(rail).toContain("a small yard");
  for (const word of ["Visibility", "Default", "Protection", "Branches"])
    expect(rail).toContain(word);
  expect(rail).toContain("Clone over HTTPS");
  expect(rail).toContain("olive/yard.git");
  expect(rail).toContain("Report it sealed");
});
