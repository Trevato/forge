/** The Files page keeps its diff work per head and never shares a viewer's markup (#4086). */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { diffBetween } from "../src/core/pulls.ts";
import { repoDir } from "../src/git/repos.ts";
import { clearDiffCache, diffCacheCounts, diffKey, keptDiff, MAX_ENTRIES } from "../src/web/diff-cache.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: Parameters<typeof commitToBranch>[1] & {};
let repo: Parameters<typeof openPull>[2];
let aliceCookie = "";
let bobCookie = "";
let number = 0;
const cells = process.env["FORGE_CELLS"];

const files = (path: string, content: string, branch?: string) =>
  commitToBranch(app, alice, repo, {
    ...(branch === undefined ? {} : { branch }),
    message: "change",
    files: [{ path, content }],
  });

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-files-cache-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const bob = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(String(bob.error));
  bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  const made2 = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!made2.ok) throw new Error(String(made2.error));
  repo = made2.value;
  for (const r of [files("forge.json", "{}"), files("t.js", "const a = 1;\n", "topic")]) {
    const done = await r;
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo, { title: "t", body: "", baseBranch: "main", headBranch: "topic" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
});

beforeEach(() => clearDiffCache());

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const view = async (cookie?: string, query = "") => {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}/files${query}`, {
    headers: cookie ? { cookie } : {},
  });
  const text = await res.text();
  return { res, text };
};
const diffPhase = (res: Response) =>
  (res.headers.get("server-timing") ?? "").split(", ").find((p) => p.startsWith("diff;"));
const rc = "?rc=t.js~new~1";

test("a second view of the same head reads the cache", async () => {
  const first = await view(aliceCookie);
  expect(first.res.status).toBe(200);
  expect(diffPhase(first.res)).not.toContain("hit");
  expect(diffCacheCounts()).toMatchObject({ hits: 0, misses: 1, entries: 1 });
  const second = await view(aliceCookie);
  expect(diffPhase(second.res)).toContain('desc="hit"');
  expect(diffCacheCounts()).toMatchObject({ hits: 1, misses: 1 });
  expect(second.text).toContain("const");
});

test("viewers with different permissions each see only their own forms", async () => {
  // The anonymous view warms the cache; the signed-in ones must not inherit it.
  const anon = await view(undefined, rc);
  const mine = await view(aliceCookie, rc);
  const other = await view(bobCookie, rc);
  expect(diffPhase(mine.res)).toContain('desc="hit"');
  expect(anon.text).not.toContain(`/pulls/${number}/review"`);
  expect(anon.text).not.toContain("?rc=");
  expect(mine.text).toContain(`/pulls/${number}/review"`);
  expect(other.text).toContain(`/pulls/${number}/review"`);
  // The writer is offered strictly more forms than a reader, and a reader more than a guest.
  const actions = (t: string) => new Set([...t.matchAll(/action="([^"]*)"/g)].map((m) => m[1]!));
  const [forAlice, forBob, forAnon] = [actions(mine.text), actions(other.text), actions(anon.text)];
  expect(forAlice.size).toBeGreaterThan(forBob.size);
  expect([...forBob].every((a) => forAlice.has(a))).toBe(true);
  expect(forBob.size).toBeGreaterThan(forAnon.size);
  // And no viewer's session or token leaks into another's page.
  expect(anon.text).not.toContain(aliceCookie.split("=")[1]!);
  expect(other.text).not.toContain(aliceCookie.split("=")[1]!);
});

test("a new head on the same pull renders fresh", async () => {
  await view(aliceCookie);
  const done = await files("u.js", "const b = 2;\n", "topic");
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const after = await view(aliceCookie);
  expect(diffPhase(after.res)).not.toContain("hit");
  expect(after.text).toContain("u.js");
  expect(diffCacheCounts().entries).toBe(2);
});

test("the cache is bounded by entries", async () => {
  const make = async () => ({ from: "f", diff: { files: [], additions: 0, deletions: 0 }, syntax: new Map() });
  for (let i = 0; i < MAX_ENTRIES + 5; i++) await keptDiff(diffKey("b", `h${i}`), make);
  expect(diffCacheCounts().entries).toBe(MAX_ENTRIES);
  await keptDiff(diffKey("b", "h0"), make);
  expect(diffCacheCounts().misses).toBe(MAX_ENTRIES + 6);
});

test("whitespace and layout options key separately", () => {
  expect(diffKey("b", "h")).not.toBe(diffKey("b", "h", { whitespace: "ignore" }));
  expect(diffKey("b", "h")).not.toBe(diffKey("b", "h", { layout: "split" }));
});

test("a failed diff is served but never kept", async () => {
  const stand = { from: "f", diff: { files: [], additions: 0, deletions: 0 }, syntax: new Map(), failed: true };
  let made = 0;
  const make = async () => (made++, stand);
  await keptDiff("k", make);
  await keptDiff("k", make);
  expect(made).toBe(2);
  expect(diffCacheCounts()).toMatchObject({ entries: 0, hits: 0 });
});

test("diffBetween flags a git failure", async () => {
  const dir = repoDir(app.reposRoot, "alice", "r");
  const bad = "0".repeat(40);
  expect((await diffBetween(dir, bad, bad)).failed).toBe(true);
});
