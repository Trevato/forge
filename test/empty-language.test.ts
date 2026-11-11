/** An empty list is a plain muted block, never a boxed card (#10017). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { renderDiff } from "../src/web/diff-view.ts";
import { empty } from "../src/web/ui.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-empty-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "root", allowReserved: true, email: "root@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  cookie = `forge_session=${createSession(app.db, r.value.id).token}`;
  const repo = await createRepo(app, r.value, { name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("empty() is a plain block and escapes its title and note", () => {
  const out = String(empty({ title: "<b>None</b>", note: "<i>x</i>" }));
  expect(out).toContain('<div class="empty">');
  expect(out).not.toContain("card empty");
  expect(out).not.toContain("<b>");
  expect(out).not.toContain("<i>");
  expect(out).toContain("&lt;b&gt;None");
});

test("an empty diff is the plain block", () => {
  const out = String(renderDiff({ files: [], additions: 0, deletions: 0 } as never));
  expect(out).toContain('class="empty"');
  expect(out).not.toContain("card empty");
});

test("a repository with no issues shows the plain block", async () => {
  const res = await fetch(servers.url + "/root/notes/issues", { headers: { cookie } });
  const html = await res.text();
  expect(html).toContain('class="empty"');
  expect(html).not.toContain("card empty");
});
