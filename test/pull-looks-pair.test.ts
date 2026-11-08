/** The pull page sets main's look beside the head's, per page, width and theme; where main has none the head stands alone (#9669). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let page = "";
let pullNumber = 0;
const MAIN = "b".repeat(40);
const HEAD = "c".repeat(40);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-pair-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const r = await createRepo(app, made.value, { name: "garden", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  await commitToBranch(app, made.value, r.value, { message: "seed", files: [{ path: "README.md", content: "# g\n" }] });
  await commitToBranch(app, made.value, r.value, { branch: "one", base: "main", message: "one", files: [{ path: "one.md", content: "x\n" }] });
  const o = await openPull(app, made.value, r.value, { title: "One", body: "", baseBranch: "main", headBranch: "one" });
  if (!o.ok) throw new Error(String(o.error));
  const a = insertApp(app.db, { repoId: r.value.id, slug: "garden", access: "public" });
  if (!a.ok) throw new Error(a.error);
  const take = (env: string, commitOid: string, extra: Pick<Parameters<typeof recordLook>[1], "kind" | "theme">) =>
    recordLook(app.db, { appId: a.value.id, env, commitOid, path: "looks/x.png", takenAs: "nobody", ...extra });
  const pr = previewEnv(o.value.number);
  take("production", MAIN, { kind: "phone" });
  take("production", MAIN, { kind: "phone", theme: "dark" });
  take(pr, HEAD, { kind: "phone" });
  take(pr, HEAD, { kind: "phone", theme: "dark" });
  take(pr, HEAD, { kind: "desktop" }); // main has no desktop look
  pullNumber = o.value.number;
  servers = await serve(app);
  page = await (await fetch(`${servers.url}/alice/garden/pulls/${o.value.number}`)).text();
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** The `data-compare` blocks, in page order: light first, then dark. */
const blocks = () => page.split("data-compare").slice(1);

test("each block puts main's picture under main and the head's under this pull, light and dark apart", () => {
  const found = blocks();
  expect(found.length).toBe(2);
  const [light, dark] = found as [string, string];
  for (const [block, file] of [[light, "phone.png"], [dark, "phone-dark.png"]] as const) {
    const cut = block.indexOf(">this pull<");
    expect(block.indexOf(">main<")).toBeGreaterThan(-1);
    expect(cut).toBeGreaterThan(block.indexOf(">main<"));
    const before = block.slice(0, cut);
    const after = block.slice(cut);
    expect(before).toContain(`/looks/production/${MAIN}/${file}`);
    expect(before).not.toContain(HEAD);
    expect(after).toContain(`/${HEAD}/${file}`);
    expect(after).not.toContain(MAIN);
  }
});

test("an unpaired look stands alone, and every image keeps its size", () => {
  expect(page).toContain(`/${HEAD}/desktop.png`);
  expect(page).not.toContain(`/production/${MAIN}/desktop`);
  // Main has no desktop look, so none is set beside it: it sits only in the head's column.
  const [light, dark] = blocks() as [string, string];
  const cut = light.indexOf(">this pull<");
  expect(light.slice(0, cut)).not.toContain("desktop");
  expect(light.slice(cut)).toContain(`/${HEAD}/desktop.png`);
  expect(dark).not.toContain("desktop");
  for (const img of page.match(/<img[^>]*looks\/[^>]*>/g) ?? [])
    expect(img).toMatch(/width="\d+"[\s\S]*height="\d+"/);
});

test("with no picture on main, the head stands alone under one line, no empty frame", async () => {
  expect(page).not.toContain("data-no-main");
  app.db.run("DELETE FROM look WHERE env = 'production'");
  const text = await (await fetch(`${servers.url}/alice/garden/pulls/${pullNumber}`)).text();
  expect(text).toContain("main has no picture of this page yet.");
  expect(text).not.toContain("data-compare");
  expect(text).not.toContain(">this pull<");
  expect(text).toContain(`/${HEAD}/phone.png`);
  expect(text).toContain(`/${HEAD}/desktop.png`);
  expect(text).not.toContain(MAIN);
});

/** Runs `body` against an empty look table, then puts every saved row back. */
async function withLooksSwapped(body: () => Promise<void>): Promise<void> {
  type Row = Record<string, unknown>;
  const saved = app.db.query("SELECT * FROM look").all() as Row[];
  app.db.run("DELETE FROM look");
  try {
    await body();
  } finally {
    app.db.run("DELETE FROM look");
    for (const r of saved) {
      const cols = Object.keys(r);
      app.db
        .query(`INSERT INTO look (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...(Object.values(r) as never[]));
    }
  }
}

test("one line over the pictures counts pages beside main and pages new to this pull", async () => {
  const a = app.db.query("SELECT id FROM app LIMIT 1").get() as { id: string };
  await withLooksSwapped(async () => {
    const take = (env: string, commitOid: string, p: string) =>
      recordLook(app.db, { appId: a.id, env, commitOid, path: "looks/x.png", takenAs: "nobody", kind: "phone", page: p });
    take("production", MAIN, "/");
    take(previewEnv(pullNumber), HEAD, "/");
    take(previewEnv(pullNumber), HEAD, "/about");
    const text = await (await fetch(`${servers.url}/alice/garden/pulls/${pullNumber}`)).text();
    expect(text).toContain("1 page beside main · 1 new to this pull");
    app.db.run("DELETE FROM look WHERE env = 'production'");
    const none = await (await fetch(`${servers.url}/alice/garden/pulls/${pullNumber}`)).text();
    expect(none).toContain("main has no pictures yet.");
    expect(none).toContain("data-no-main");
  });
});
