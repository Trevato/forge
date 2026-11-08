/**
 * The milestones page's HTML, pinned on a 20-milestone, 1,000-issue seed
 * (#3428), so a speed change that alters the output fails here and not on a
 * clock. No wall-clock assertion. The page reads the real clock and the seed
 * is offsets from it, so rendered times are normalised away: the 7-day merge
 * window is pinned by its count, not at its edges. Regenerate with `UPDATE_GOLDEN=1 bun test
 * test/milestones-golden.test.ts` and read the diff.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedMilestones } from "./fixtures/milestones-seed.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const GOLDEN = join(import.meta.dir, "fixtures", "milestones-golden.html");

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-milestones-golden-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  seedMilestones(app.db, made.value.id, u.value.id, new Date());
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * The page with what changes between runs replaced (the nonce, the port, every
 * rendered time), cut to the milestones' own output: from the page head to the
 * end of `#ms-limbs`. The shell around it (menus, assets, footer) is not this
 * page's to pin.
 */
function normalise(htmlText: string): string {
  const start = htmlText.indexOf('<div class="page-head');
  const end = htmlText.search(/\n\s*<div\s+id="live"/);
  if (start < 0 || end < start) throw new Error("the milestones content was not found in the page");
  return htmlText
    .slice(start, end)
    .replaceAll(servers.url, "http://ORIGIN")
    .replace(/nonce="[^"]*"/g, 'nonce="NONCE"')
    .replace(/(<time datetime=")[^"]*(" title=")[^"]*("\s*>)[^<]*(<\/time\s*>)/g, "$1T$2T$3AGO$4")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "TIME");
}

/** Compare to the pinned file; a missing file is a failure unless UPDATE_GOLDEN=1. */
function pinned(file: string, got: string): void {
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, got);
  if (!existsSync(file)) throw new Error(`${file} is missing; run with UPDATE_GOLDEN=1 to write it`);
  expect(got).toBe(readFileSync(file, "utf8"));
}

test("GET /:owner/:name/milestones renders the pinned HTML", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}/alice/forge/milestones`, { headers: { cookie } });
  expect(res.status).toBe(200);
  pinned(GOLDEN, normalise(await res.text()));
});

test("a guest is told nothing of a private repository's milestones", async () => {
  const res = await fetch(`${servers.url}/alice/forge/milestones`);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("Milestone 0000");
});

test("the list and an opened milestone are headings over rows, with no card box around them (#9693)", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const list = await (await fetch(`${servers.url}/alice/forge/milestones`, { headers: { cookie } })).text();
  const main = list.slice(list.indexOf('id="ms-limbs"'));
  expect(main).toContain('<ul class="list setting-list">');
  const section = main.slice(0, main.search(/\n\s*<div\s+id="live"/));
  expect(section).not.toContain('class="card');
  const href = /href="(\/alice\/forge\/milestones\/\d+)"/.exec(list)?.[1];
  expect(href).toBeDefined();
  const one = await (await fetch(`${servers.url}${href}`, { headers: { cookie } })).text();
  const body = one.slice(one.indexOf("<h1>"), one.search(/\n\s*<div\s+id="live"/));
  expect(body).not.toMatch(/class="card[ "]/);
  expect(body).toContain('id="ms-progress"');
  expect(body).toContain('<ul class="list setting-list">');
});
