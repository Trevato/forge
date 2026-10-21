/**
 * /settings/backups draws its now, drill, error and restore parts with the
 * design system's card, row, badge and btn: no `.backups-*` class of the old
 * markup, every sentence that can carry a long id wraps, the restore command
 * is a scrollable pre in the card body, and every form posts what it did.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { recordDrill } from "../src/snapshot/drills.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let svc: SnapshotsHandle;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-backups-parts-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  svc = startSnapshots(app, dirStore(join(root, "store")), { version: "t", nightly: false });
  servers = await serve(app);
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(async () => {
  servers.stop();
  await svc.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (): Promise<string> =>
  (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();

const OLD_CLASS = /class="[^"]*\bbackups-/;

test("the page carries none of the old classes, and keeps its words, links and forms", async () => {
  await svc.now();
  const page = await get();
  expect(page).not.toMatch(OLD_CLASS);
  expect(page).toContain('id="backups-live"');
  expect(page).toContain('class="badge"');
  expect(page).toContain("Snapshot now");
  expect(page).toContain("Run a drill");
  expect(page).toContain("No restore drill has run yet.");
  expect(page).toContain('action="/settings/backups/now"');
  expect(page).toContain('action="/settings/backups/drill"');
  expect(page).toContain('action="/settings/backups/destination"');
  expect(page).toContain('href="/settings/backups"');
});

test("the restore command is a scrollable pre in the card body, not in the foot", async () => {
  const page = await get();
  const pre = /<pre[^>]*>[^]*?<\/pre>/.exec(page)?.[0] ?? "";
  expect(pre).toContain('tabindex="0"');
  expect(pre).toContain("aria-label=");
  expect(pre).toContain("bun run src/snapshot/restore.ts");
  const at = page.indexOf(pre);
  const body = page.lastIndexOf('class="card-body"', at);
  const foot = page.lastIndexOf('class="card-foot"', at);
  expect(body).toBeGreaterThan(foot);
});

test("the paragraphs that can carry a long id, reason or step wrap", async () => {
  const long = "x".repeat(120);
  const wraps = (page: string, needle: string): boolean => {
    const at = page.indexOf(needle);
    const open = page.lastIndexOf("<p", at);
    return page.slice(open, page.indexOf(">", open)).includes('class="break"');
  };
  const counts = { users: 1, repositories: 1, issues: 1, pulls: 1, apps: 1 };
  const base = { at: new Date().toISOString(), ms: 5, counts, health: "ok", phases: [], budgetMs: 0 } as const;
  recordDrill(app.db, { ...base, snapshotId: long, verdict: "green", failedStep: null, reason: null });
  expect(wraps(await get(), long)).toBe(true);
  recordDrill(app.db, {
    ...base,
    snapshotId: long + "y",
    verdict: "red",
    failedStep: "restore" as never,
    reason: long + "reason",
  });
  const page = await get();
  expect(wraps(page, long + "y")).toBe(true);
  expect(wraps(page, long + "reason")).toBe(true);
});

test("a failed snapshot and a failed listing wrap too", async () => {
  const long = "z".repeat(120);
  const bad = startSnapshots(app, { ...dirStore(join(root, "bad")), put: async () => { throw new Error(long); } }, {
    version: "t",
    nightly: false,
  });
  await expect(bad.now()).rejects.toThrow();
  const page = await get();
  await bad.stop();
  const open = page.lastIndexOf("<p", page.indexOf(long));
  expect(page.slice(open, page.indexOf(">", open))).toContain('class="break"');
});

test("a listing that fails is a badge and a wrapping paragraph, and no old class", async () => {
  const long = "q".repeat(120);
  const inner = dirStore(join(root, "unlistable"));
  const broken = startSnapshots(
    app,
    {
      ...inner,
      list: async (): Promise<string[]> => {
        throw new Error(long);
      },
      names: async (): Promise<string[]> => {
        throw new Error(long);
      },
    },
    { version: "t", nightly: false },
  );
  const page = await get();
  await broken.stop();
  expect(page).not.toMatch(OLD_CLASS);
  const open = page.lastIndexOf("<p", page.indexOf(long));
  expect(page.slice(open, page.indexOf(">", open))).toContain('class="break"');
  expect(page.slice(open, page.indexOf("</p>", open))).toContain("The store could not be listed");
});
