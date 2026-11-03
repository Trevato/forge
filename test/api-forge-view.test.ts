/**
 * The forge's read-only view (#8955): GET /api/v1/forge/view gives apps, runs
 * and health to any token, writes nothing, matches the reads home and the
 * board use, and costs one build per window however often it is polled.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { foundryHref, forgetFoundryDoor } from "../src/actions/foundry_door.ts";
import { forgeView, VIEW_APPS, viewBuilds } from "../src/actions/forge_view.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { forgeViewLines, forgeViewScreen } from "../src/tui/screens/forgeview.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createRepo as createRepoRow } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { writableAppsOf } from "../src/web/studio/asks.ts";
import { listActiveRuns } from "../src/core/runs.ts";
import type { Ctx } from "../src/http/context.ts";

quietLogs();

const APPS = 120;

describe("the forge view over the API", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let ro: string;
  let admin: Awaited<ReturnType<typeof seedAdmin>>;
  const get = (token?: string, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}/api/v1/forge/view`, {
      headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-view-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    admin = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!admin.ok) throw new Error(admin.error);
    for (let i = 0; i < APPS; i++) {
      const repo = await createRepo(app, admin.value, { name: `app${i}`, visibility: "public" });
      if (!repo.ok) throw new Error(String(repo.error));
      createAppRecord(app.db, { repoId: repo.value.id, slug: `app${i}`, access: "public" });
      for (let n = 0; n < 8; n++)
        createRun(app.db, { repoId: repo.value.id, kind: "agent", reason: "work" });
    }
    ro = createToken(app.db, admin.value.id, "t", "ro").token;
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no credentials is a 401", async () => {
    expect((await get()).status).toBe(401);
  });

  test("a read-only token reads apps, runs and health, matching home and the board's sources", async () => {
    const res = await get(ro);
    expect(res.status).toBe(200);
    const view = (await res.json()) as any;
    const ctx = { app, auth: { user: admin.ok ? admin.value : undefined } } as unknown as Ctx;
    const mine = writableAppsOf(ctx, admin.ok ? admin.value : undefined).repos;
    expect(view.counts.apps).toBe(APPS);
    expect(view.apps.length).toBe(mine.length);
    // The runs are the same bounded list crew/now and the board read.
    const active = listActiveRuns(app.db, mine.map((r) => r.id));
    expect(view.counts.queued + view.counts.running).toBe(active.length);
    expect(view.runs.length).toBeLessThanOrEqual(50 + view.counts.waiting);
    expect(view.health.ok).toBe(true);
    const now = (await (await fetch(`${servers.url}/api/v1/crew/now`, { headers: { authorization: `Bearer ${ro}` } })).json()) as any;
    expect(view.runs).toEqual(now.items);
  });

  test("polling costs one build per window and a held ETag is a 304", async () => {
    await get(ro);
    const before = viewBuilds();
    const selects: string[] = [];
    const original = app.db.query.bind(app.db);
    (app.db as unknown as { query: unknown }).query = (sql: string) => {
      selects.push(sql);
      return original(sql);
    };
    try {
      const first = await get(ro);
      const etag = first.headers.get("etag")!;
      for (let i = 0; i < 20; i++) expect((await get(ro)).status).toBe(200);
      expect((await get(ro, { "if-none-match": etag })).status).toBe(304);
    } finally {
      (app.db as unknown as { query: unknown }).query = original;
    }
    expect(viewBuilds() - before).toBeLessThanOrEqual(1);
    // Reads of the view itself stay few, however many apps and runs: the
    // statements are per-request constants, not per app (the token lookup
    // and session reads are all that remain on a cached answer).
    expect(selects.filter((s) => /FROM run\b/.test(s)).length).toBeLessThanOrEqual(1);
    expect(selects.length).toBeLessThan(80);
  });

  test("a ro token can't write through it", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${servers.url}/api/v1/forge/view`, {
        method,
        headers: { authorization: `Bearer ${ro}`, "content-type": "application/json" },
        body: method === "DELETE" ? null : "{}",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect([404, 405]).toContain(res.status);
    }
    const before = (await (await get(ro)).json() as any).counts.apps;
    const made = await fetch(`${servers.url}/api/v1/apps`, {
      method: "POST",
      headers: { authorization: `Bearer ${ro}`, "content-type": "application/json" },
      body: JSON.stringify({ repo: "ada/app0", slug: "sneaky" }),
    });
    expect(made.status).toBe(403);
    expect(before).toBe(APPS);
  });

  test("a cold build over the fixture is a constant number of reads, with bounded lists", () => {
    const ctx = { app, auth: { user: admin.ok ? admin.value : undefined } } as unknown as Ctx;
    const selects: string[] = [];
    const original = app.db.query.bind(app.db);
    (app.db as unknown as { query: unknown }).query = (sql: string) => {
      selects.push(sql);
      return original(sql);
    };
    let view;
    try {
      view = forgeView(ctx, admin.ok ? admin.value : (undefined as never));
    } finally {
      (app.db as unknown as { query: unknown }).query = original;
    }
    expect(view.counts.apps).toBe(APPS);
    expect(view.apps.length).toBeLessThanOrEqual(VIEW_APPS);
    expect(view.runs.filter((r) => r.run !== null).length).toBeLessThanOrEqual(50);
    // 120 apps, 960 runs. `mayReadRuns` (shared with /crew/now) reads two
    // rows per app today; anything beyond that, or a read per run, fails.
    expect(selects.length).toBeLessThanOrEqual(2 * APPS + 20);
  });

  test("foundry has a door only for an app an admin or the forge's org owns", async () => {
    const adminUser = admin.ok ? admin.value : (undefined as never);
    const door = () => foundryHref(app, adminUser);
    const lines = () => forgeViewLines({ app, user: adminUser } as never);
    expect(door()).toBeUndefined();
    // A non-admin who names an app `foundry` first plants no door.
    const mallory = await createUser(app.db, { username: "mallory", email: "m@forge.example", password: "a-long-passphrase-here", origin: "seed", trusted: true });
    if (!mallory.ok) throw new Error(mallory.error);
    const fake = await createRepo(app, adminUser, { name: "foundry", visibility: "public" });
    if (!fake.ok) throw new Error(String(fake.error));
    app.db.query("UPDATE repo SET owner_id = ?1 WHERE id = ?2").run(mallory.value.id, fake.value.id);
    createAppRecord(app.db, { repoId: fake.value.id, slug: "foundry", access: "public" });
    forgetFoundryDoor(app);
    expect(door()).toBeUndefined();
    expect(await homeAndPalette(adminUser.id)).toEqual({ button: false, row: false });
    expect(lines().lines[1]).toContain("not installed");
    app.db.query("DELETE FROM app WHERE repo_id = ?1").run(fake.value.id);
    // The admin's own is Foundry.
    const repo = await createRepo(app, adminUser, { name: "foundry", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    createAppRecord(app.db, { repoId: repo.value.id, slug: "foundry", access: "public" });
    forgetFoundryDoor(app);
    expect(door()).toBe("/ada/foundry/app/production/open");
    expect(foundryHref(app, undefined)).toBeUndefined();
    expect(await homeAndPalette(adminUser.id)).toEqual({ button: true, row: true });
    expect(lines().lines[1]).toContain("/ada/foundry/app/production/open");
  });

  test("an app of the trevato org is Foundry for a reader who is no admin", async () => {
    // Move the admin's Foundry away; the org's takes the slug.
    app.db.query("DELETE FROM app WHERE slug = 'foundry'").run();
    const org = createOrg(app.db, "trevato", admin.ok ? admin.value.id : "");
    if (!org.ok) throw new Error(String(org.error));
    const made = await createRepoRow(app.db, app.reposRoot, { ownerId: org.value.id, name: "foundry", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    createAppRecord(app.db, { repoId: made.value.id, slug: "foundry", access: "public" });
    const reader = await createUser(app.db, { username: "reader", email: "r@forge.example", password: "a-long-passphrase-here", origin: "seed", trusted: true });
    if (!reader.ok) throw new Error(reader.error);
    forgetFoundryDoor(app);
    expect(foundryHref(app, reader.value)).toBe("/trevato/foundry/app/production/open");
    // The answer is held, so the next page render costs no read.
    const seen: string[] = [];
    const original = app.db.query.bind(app.db);
    (app.db as unknown as { query: unknown }).query = (sql: string) => (seen.push(sql), original(sql));
    try {
      expect(foundryHref(app, reader.value)).toBe("/trevato/foundry/app/production/open");
    } finally {
      (app.db as unknown as { query: unknown }).query = original;
    }
    expect(seen).toEqual([]);
    // The terminal's Enter opens it; with no door it does nothing.
    const opened: string[] = [];
    const ctxT = { toast: (m: string) => opened.push(m), theme: { c: {} } } as never;
    const session = { app, user: reader.value } as never;
    const screen = forgeViewScreen(session, ctxT);
    expect(screen.key!({ key: "enter" } as never)).toBe(true);
    expect(opened.join()).toContain("/trevato/foundry/app/production/open");
    app.db.query("DELETE FROM app WHERE slug = 'foundry'").run();
    forgetFoundryDoor(app);
    const none = forgeViewScreen(session, ctxT);
    opened.length = 0;
    expect(none.key!({ key: "enter" } as never)).toBe(false);
    expect(opened).toEqual([]);
  });

  /** Whether `/` shows the Foundry button and the palette index the row, for a user. */
  async function homeAndPalette(userId: string) {
    const cookie = `forge_session=${createSession(app.db, userId).token}`;
    const html = await (await fetch(`${servers.url}/`, { headers: { cookie } })).text();
    // Home's apps card is a live region with its own address.
    const card = await (await fetch(`${servers.url}/live/apps`, { headers: { cookie } })).text();
    const index = /id="palette-index">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    return {
      button: /href="\/ada\/foundry\/app\/production\/open"[^>]*>\s*(<[^>]*>\s*)*Foundry/.test(card),
      row: index.includes('{"t":"Foundry","h":"/ada/foundry/app/production/open","c":"Go to"}'),
    };
  }
});
