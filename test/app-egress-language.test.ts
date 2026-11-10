/**
 * The hosts an app's code reached undeclared speak the home page's language
 * (#9971): a settings-block under an h2, one row per host, the forge.json
 * line to copy, no card; for the app's writers only, and each host escaped.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { noteReached } from "../src/apps/egress_report.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { egressNote } from "../src/web/studio/egress.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { giveHistory } from "./helpers/history.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers, repo: Repo;
let writer = "", reader = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-app-egress-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "b@forge.local", password: "correct-horse-battery" });
  if (!b.ok) throw new Error(b.error);
  const r = await createRepo(app, a.value, { name: "notes", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
  const made = createAppRecord(app.db, { repoId: repo.id, slug: "notes", access: "public" });
  if (!made.ok) throw new Error(made.error);
  giveHistory(app.db, repo.id);
  setCapacity(app.db, "cells.egress", "report", a.value.id);
  noteReached(dataDir, repo.id, "api.example.com", 443);
  noteReached(dataDir, repo.id, "api.example.com", 443);
  noteReached(dataDir, repo.id, "db.example.com", 5432);
  writer = `forge_session=${createSession(app.db, getUserByName(app.db, "alice")!.id).token}`;
  reader = `forge_session=${createSession(app.db, getUserByName(app.db, "bobby")!.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const page = async (cookie: string | null) =>
  (await fetch(`${servers.url}/alice/notes/app`, cookie ? { headers: { cookie } } : {})).text();
const block = (p: string) => {
  const at = p.indexOf('id="app-egress"');
  return at < 0 ? "" : p.slice(p.lastIndexOf("<", at), p.indexOf("</section>", at));
};

test("a writer sees a settings-block under an h2, one row per host, the line to copy, no card", async () => {
  const b = block(await page(writer));
  expect(b).toMatch(/^<section class="settings-block" id="app-egress">\s*<h2>[^<]+<\/h2>/);
  expect(b).not.toContain('class="card');
  expect((b.match(/class="row"/g) ?? []).length).toBe(2);
  expect(b).toContain("<code>api.example.com:443</code>");
  expect(b).toContain("<code>db.example.com:5432</code>");
  expect(b).toContain("2×");
  expect(b).toContain("once it is enforced they are refused");
  expect(b).toContain('"egress": [' + "&quot;db.example.com:5432&quot;,&quot;api.example.com&quot;]");
});

test("a reader and a stranger see nothing of it", async () => {
  expect(await page(reader)).not.toContain('id="app-egress"');
  expect(await page(null)).not.toContain('id="app-egress"');
});

test("once egress is enforced the note is gone, on the page too", async () => {
  expect(egressNote(dataDir, repo.id, [], "enforce")).toBeNull();
  setCapacity(app.db, "cells.egress", "enforce", getUserByName(app.db, "alice")!.id);
  try {
    expect(await page(writer)).not.toContain('id="app-egress"');
  } finally {
    setCapacity(app.db, "cells.egress", "report", getUserByName(app.db, "alice")!.id);
  }
});

test("nothing reached, or all of it declared since, draws nothing", () => {
  expect(egressNote(dataDir, "0nothing0", [], "report")).toBeNull();
  expect(egressNote(dataDir, repo.id, ["api.example.com", "db.example.com:5432"], "report")).toBeNull();
});

test("a host is text, never markup", () => {
  noteReached(dataDir, "0hostile0", "<img src=x>.example.com", 443);
  const b = egressNote(dataDir, "0hostile0", [], "report")!.text;
  expect(b).not.toContain("<img");
  expect(b).toContain("&lt;img src=x&gt;.example.com:443");
});
