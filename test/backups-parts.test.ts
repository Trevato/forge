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
import { forgetReads, keepReads } from "../src/snapshot/bucket.ts";
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

test("the restore command is a scrollable pre in the Snapshots block, not in a box", async () => {
  const page = await get();
  const pre = /<pre[^>]*>[^]*?<\/pre>/.exec(page)?.[0] ?? "";
  expect(pre).toContain('class="restore-command"');
  expect(page).not.toContain("domain-records");
  expect(pre).toContain('tabindex="0"');
  expect(pre).toContain("aria-label=");
  expect(pre).toContain("bun run src/snapshot/restore.ts");
  const from = page.indexOf("<h2>Snapshots</h2>");
  expect(from).toBeGreaterThan(-1);
  const block = page.slice(from, page.indexOf("</section>", from));
  expect(block).toContain(pre);
  expect(block).toContain('id="snapshots"');
  expect(page).not.toContain('class="card');
});

test("snapshots are rows under a heading, and no section is a card (#9708)", async () => {
  await svc.now();
  const page = await get();
  const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
  expect(main).toContain('<ul class="list setting-list" id="snapshots">');
  expect(main).toContain('class="row-title"');
  for (const h of ["Where and when", "Snapshots", "Destination", "Off-box mirror"]) expect(main).toContain(`<h2>${h}</h2>`);
  for (const boxed of ['class="card', "card-head", "card-body", 'class="empty']) expect(main).not.toContain(boxed);
  expect(main).toContain('id="backups-live" data-live="backup.*" data-live-src="/settings/backups/live"');
});

test("Lanes and Failure domains are headed sections, not cards (#9708)", async () => {
  keepReads(root, [
    { lane: "primary", where: "bucket/forge", offBox: true, newestAt: new Date().toISOString(), newestName: "n", newestBytes: 5, count: 1, readAt: new Date().toISOString() },
  ]);
  try {
    const page = await get();
    const lanes = page.slice(page.indexOf("<h2>Lanes</h2>"));
    expect(page).toContain("<h2>Lanes</h2>");
    expect(lanes.slice(0, lanes.indexOf("</section>"))).toContain('id="backup-lanes"');
    const domains = page.slice(page.indexOf("<h2>Failure domains</h2>"));
    expect(page).toContain("<h2>Failure domains</h2>");
    expect(domains.slice(0, domains.indexOf("</section>"))).toContain('id="resilience-list"');
    expect(page).not.toContain('class="card');
  } finally {
    forgetReads(root);
  }
});

test("with no snapshot store the page says so under a plain heading, not in an empty-state box (#9708)", async () => {
  const bare = mkdtempSync(join(tmpdir(), "forge-backups-bare-"));
  const other = createApp({ dataDir: bare, port: 0 });
  const made = await createUser(other.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const srv = await serve(other);
  try {
    const r = await fetch(`${srv.url}/signin`, {
      method: "POST",
      headers: { origin: srv.url },
      body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const own = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${srv.url}/settings/backups`, { headers: { cookie: own } })).text();
    const from = page.indexOf("<h2>No snapshots are taken</h2>");
    expect(from).toBeGreaterThan(-1);
    expect(page.slice(from, page.indexOf("</section>", from))).toContain("This forge was given nowhere to put them.");
    for (const boxed of ['class="card', 'class="empty', "card-body"]) expect(page).not.toContain(boxed);
  } finally {
    srv.stop();
    other.close();
    rmSync(bare, { recursive: true, force: true });
  }
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
