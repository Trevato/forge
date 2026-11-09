/** The releases page joins the shell's j/k row traversal: one `data-nav` row per release, none when empty (#10343). */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { markVerified } from "../src/core/verify.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { recordRelease } from "../src/release/record.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-releases-keys-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  app.db
    .query("INSERT INTO user (id, username, email, password_hash, is_admin) VALUES ('u-alice', 'alice', 'alice@forge.local', 'x', 1)")
    .run();
  markVerified(app.db, "u-alice", new Date().toISOString());
  cookie = `forge_session=${createSession(app.db, "u-alice").token}`;
  const made = await createRepo(app, { id: "u-alice", username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async () => (await fetch(`${servers.url}/releases`, { headers: { cookie } })).text();

test("a page with no rows has no data-nav", async () => {
  const text = await get();
  expect(text).toContain("No releases yet");
  expect(text).not.toContain("data-nav");
});

test("each release row is a data-nav link to its pull", async () => {
  const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='forge'").get()!.id;
  recordRelease(app.db, { sha: "d".repeat(40), repoId, pullNumber: 3, ok: true, line: "ok" });
  recordRelease(app.db, { sha: "e".repeat(40), repoId, pullNumber: 4, ok: true, line: "ok" });
  const text = await get();
  const navs = text.match(/<a [^>]*data-nav[^>]*>/g) ?? [];
  expect(navs.length).toBe(2);
  expect(navs.some((a) => a.includes('href="/alice/forge/pulls/3"'))).toBe(true);
  expect(navs.some((a) => a.includes('href="/alice/forge/pulls/4"'))).toBe(true);
  expect(navs.every((a) => a.includes('tabindex="-1"'))).toBe(true);
});
