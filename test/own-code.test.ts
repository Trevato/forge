/**
 * A child forge runs its own code (#11144): the switch, the checked copy, the
 * rollback and its card, and the way back. Cells themselves are not needed:
 * `startFirstThatWorks` takes the start as a function.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { cellSpecFor } from "../src/spawn/cell.ts";
import { clientRows } from "../src/spawn/clients.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { ownCodePicks } from "../src/tui/screens/forges.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { getUserByName } from "../src/core/users.ts";
import { settleApp } from "./helpers/tui.ts";
import { ownCode } from "../src/spawn/manage.ts";
import { checkTree, oneAtATime, readOwnCode, recordGood, sourcesFor, startFirstThatWorks, switchOwnCode, useTree, walkTree, type CodeSource } from "../src/spawn/own_code.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;
const childDir = () => join(dataDir, "children", "cell-1");
const repo = () => join(childDir(), "repos", "kid", "forge.git");
const parent = { main: "/code/src/main.ts", root: "/code" };

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/** Commit a tree to the child's forge repository's main. */
function commit(files: Record<string, string>): string {
  const work = join(dataDir, "work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  if (!existsSync(repo())) {
    mkdirSync(repo(), { recursive: true });
    git(["init", "--bare", "-b", "main", repo()], dataDir);
  }
  git(["clone", "--quiet", repo(), work], dataDir);
  git(["checkout", "-B", "main"], work);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    rmSync(join(work, path), { force: true });
    if (text.startsWith("->")) symlinkSync(text.slice(2), join(work, path));
    else writeFileSync(join(work, path), text);
  }
  git(["add", "-A"], work);
  git(["commit", "--quiet", "-m", "change"], work);
  git(["push", "--quiet", "origin", "main"], work);
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: work }).stdout.toString().trim();
}
const tree = (visible: string) => ({ "src/main.ts": `export const visible = ${JSON.stringify(visible)};\n`, "forge.json": "{}" });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "own-code-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "alice", email: "alice@forge.local" });
  mkdirSync(join(dataDir, "spawn"), { recursive: true });
  for (const [name, placement] of [["kid", "cell"], ["inner", "hosted"]] as const)
    writeFileSync(join(dataDir, "spawn", `${name}.json`), JSON.stringify({ name, bodyId: name === "kid" ? "cell-1" : "h-1", done: true, placement }));
});
afterAll(async () => {
  await servers.stop?.();
  app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const sources = (name = "kid") => sourcesFor(app, { name, childDir: childDir() }, parent);
const ok = (s: { kind: string }) => async () => ({ child: s.kind });
/** The i-th source, or a failure that names it. */
function nth(found: readonly CodeSource[], i: number): CodeSource {
  const s = found[i];
  if (s === undefined) throw new Error(`no source ${i} in ${found.map((f) => f.kind).join(",")}`);
  return s;
}
/** Payloads of the events of one kind, oldest first. */
const events = (kind: string): Record<string, unknown>[] =>
  (app.db.query("SELECT payload FROM event WHERE kind = ? ORDER BY rowid").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

test("off by default: the parent's code, and a hosted forge cannot turn it on", async () => {
  expect(readOwnCode(app, "kid")).toEqual({ on: false });
  expect((await sources()).map((s) => s.kind)).toEqual(["parent"]);
  const hosted = await ownCode(app, "inner", true);
  expect(hosted.ok).toBe(false);
  expect(hosted.says).toContain("inside its parent's process");
  // A cell forge with no repository of its own is told so, too.
  const none = await ownCode(app, "kid", true);
  expect(none).toEqual({ ok: false, says: "This forge has no forge repository of its own yet." });
});

test("on: it starts from a checked copy of its own main, and what it shows is its change", async () => {
  commit(tree("v1"));
  expect((await ownCode(app, "kid", true)).ok).toBe(true);
  expect(events("forge.own_code_on")).toEqual([{ name: "kid" }]);
  const found = await sources();
  expect(found.map((s) => s.kind)).toEqual(["own", "parent"]);
  const own = nth(found, 0);
  expect(readFileSync(own.main, "utf8")).toContain('"v1"');
  expect(existsSync(join(own.root, ".git"))).toBe(false);
  const started = await startFirstThatWorks(app, "kid", found, ok(own));
  expect("child" in started && started.source.kind).toBe("own");
  expect(readOwnCode(app, "kid").good).toBe(own.commit);
  expect(readOwnCode(app, "kid").rolledBack).toBeUndefined();
});

test("the cell is the same either way: its own code only adds a revealed tree", () => {
  const base = { dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", size: "small" as const, port: 4100, label: "forge:kid" };
  const a = cellSpecFor(base);
  const b = cellSpecFor({ ...base, ownRoot: "/d/own-code/kid/abc" });
  expect(JSON.parse(JSON.stringify({ ...b, reveal: a.reveal }))).toEqual(JSON.parse(JSON.stringify(a)));
  expect(b.reveal).toContain("/d/own-code/kid/abc");
});

test("a broken main is rolled back to the last good commit, with a card", async () => {
  const good = readOwnCode(app, "kid").good;
  expect(good).toBeDefined();
  commit({ ...tree("v2"), "src/main.ts": "export const = ;;{" });
  const found = await sources();
  expect(found.map((s) => s.kind)).toEqual(["last-good", "parent"]);
  expect(nth(found, 0).commit).toBe(good);
  const state = readOwnCode(app, "kid");
  expect(state.rolledBack?.to).toBe("last-good");
  expect(state.rolledBack?.why).toContain("does not parse");
  const page = await (await fetch(`${servers.url}/forges`, { headers: { cookie } })).text();
  expect(page).toContain("data-rolled-back");
  expect(page).toContain("its last good commit");
  expect(page).toContain("Shares this forge's process");
  expect(events("forge.rolled_back").at(-1)).toMatchObject({ name: "kid", to: "last-good", why: "src/main.ts does not parse" });
});

test("a failed commit is not checked out or reported again until main moves", async () => {
  const before = events("forge.rolled_back").length;
  expect((await sources()).map((s) => s.kind)).toEqual(["last-good", "parent"]);
  expect(events("forge.rolled_back").length).toBe(before);
});

test("a symlinked main or forge.json is refused, and none of the target is repeated", async () => {
  const secret = join(dataDir, "secret.key");
  writeFileSync(secret, "TOP-SECRET-VALUE {{");
  for (const link of ["src/main.ts", "forge.json"]) {
    commit({ ...tree("v3"), [link]: `->${secret}` });
    await sources();
    const state = readOwnCode(app, "kid");
    expect(state.rolledBack?.why).toBe("it contains a symbolic link");
    expect(JSON.stringify(state)).not.toContain("TOP-SECRET");
  }
  commit(tree("v4"));
});

test("a main that parses but never answers falls back, then to the parent's code", async () => {
  commit(tree("v3"));
  const found = await sources();
  expect(found.map((s) => s.kind)).toEqual(["own", "last-good", "parent"]);
  const tried: string[] = [];
  const started = await startFirstThatWorks(app, "kid", found, async (s) => {
    tried.push(s.kind);
    return s.kind === "parent" ? { child: "up" } : { why: "its cell did not come up: boom" };
  });
  expect(tried).toEqual(["own", "last-good", "parent"]);
  expect("child" in started && started.source.kind).toBe("parent");
  const rb = readOwnCode(app, "kid").rolledBack;
  expect(rb?.to).toBe("parent");
  expect(rb?.why).toContain("boom");
  const last = events("forge.rolled_back").slice(-2);
  expect(last.map((e) => e["to"])).toEqual(["last-good", "parent"]);
});

test("a cell that cannot be made is a failed attempt: the next source is tried", async () => {
  const found: CodeSource[] = [{ kind: "last-good", commit: "a".repeat(40), main: "/x/src/main.ts", root: "/x" }, { kind: "parent", ...parent }];
  const started = await startFirstThatWorks(app, "kid", found, async (s) => {
    if (s.kind !== "parent") throw new Error("cgroup refused");
    return { child: "up" };
  });
  expect("child" in started && started.source.kind).toBe("parent");
  expect(readOwnCode(app, "kid").rolledBack?.why).toBe("its cell could not be made");
});

test("pruning after a good start keeps any tree a cell still reads", () => {
  const base = join(dataDir, "own-code", "kid");
  const held = join(base, "b".repeat(40));
  const loose = join(base, "c".repeat(40));
  for (const d of [held, loose]) mkdirSync(d, { recursive: true });
  const release = useTree(held);
  recordGood(app, "kid", "d".repeat(40));
  expect(existsSync(held)).toBe(true);
  expect(existsSync(loose)).toBe(false);
  release();
  recordGood(app, "kid", "e".repeat(40));
  expect(existsSync(held)).toBe(false);
});

test("starts of one forge run one at a time", async () => {
  const order: string[] = [];
  const slow = (tag: string, ms: number) => async () => {
    order.push(`${tag}+`);
    await Bun.sleep(ms);
    order.push(`${tag}-`);
  };
  await Promise.all([oneAtATime(app, "kid", slow("a", 30)), oneAtATime(app, "kid", slow("b", 1))]);
  expect(order).toEqual(["a+", "a-", "b+", "b-"]);
});

test("a repository or tree past the caps is too large", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-big-"));
  writeFileSync(join(dir, "a"), "x".repeat(100));
  expect(walkTree(dir, { bytes: 50, files: 10 })).toBe("big");
  expect(walkTree(dir, { bytes: 500, files: 10 })).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("a start that fails on every source says why", async () => {
  const found = await sources();
  const started = await startFirstThatWorks(app, "kid", found, async () => ({ why: "nope" }));
  expect(started).toEqual({ why: "nope" });
});

test("off returns it to the parent's code and clears what was kept", async () => {
  expect((await ownCode(app, "kid", false)).ok).toBe(true);
  expect(events("forge.own_code_off")).toEqual([{ name: "kid" }]);
  expect(readOwnCode(app, "kid")).toEqual({ on: false });
  expect((await sources()).map((s) => s.kind)).toEqual(["parent"]);
  expect(existsSync(join(dataDir, "own-code", "kid"))).toBe(false);
});

test("the switch is the admin's, same-origin, and takes only on or off", async () => {
  const post = (body: string, headers: Record<string, string>) =>
    fetch(`${servers.url}/forges/kid/own-code`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
  expect((await post("on=on", { cookie, origin: "https://evil.test" })).status).toBe(403);
  expect((await post("on=on", { origin: servers.url })).status).toBe(404);
  expect((await post("on=maybe", { cookie, origin: servers.url })).status).toBe(404);
  const done = await post("on=on", { cookie, origin: servers.url });
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe("/forges?code=on&forge=kid#forge-code");
  expect(readOwnCode(app, "kid").on).toBe(true);
  const back = await (await fetch(`${servers.url}/forges?code=on&forge=kid`, { headers: { cookie } })).text();
  expect(back).toContain("kid will run its own code from its next start.");
  const hosted = await post("on=on", { cookie, origin: servers.url }).then(() =>
    fetch(`${servers.url}/forges/inner/own-code`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: servers.url }, body: "on=on" }),
  );
  expect(hosted.headers.get("location")).toBe("/forges?code=refused&forge=inner#forge-code");
  expect((await post("on=off", { cookie, origin: servers.url })).status).toBe(303);
  expect(readOwnCode(app, "kid").on).toBe(false);
  expect(switchOwnCode(app, { name: "../x", placement: "cell", childDir: childDir(), on: true }).ok).toBe(false);
});

test("the terminal's o picker says whose code each runs and switches it, as the page does", async () => {
  const rows = await clientRows(app);
  expect(ownCodePicks(app, rows).find((p) => p.id === "kid")?.hint).toStartWith("this forge's code");
  const terminal = headlessTerminal(140, 32);
  const user = getUserByName(app.db, "alice") ?? undefined;
  const { app: tui } = createForgeApp(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
  tui.start();
  const key = async (k: string, ctrl = false) => {
    tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(tui);
  };
  await key("k", true);
  for (const ch of "Forges you sent") await key(ch);
  await key("enter");
  await key("o");
  expect(tui.screen.toText()).toContain("Switch whose code");
  await key("/");
  for (const ch of "kid") await key(ch);
  await key("enter");
  expect(tui.screen.toText()).toContain("▸ kid");
  await key("enter");
  await Bun.sleep(50);
  await settleApp(tui);
  expect(readOwnCode(app, "kid").on).toBe(true);
  tui.stop();
  expect((await ownCode(app, "kid", false)).ok).toBe(true);
});

test("a tree without an entry or a manifest is not green", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-tree-"));
  expect(checkTree(dir)).toContain("no src/main.ts");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.ts"), "export {};");
  expect(checkTree(dir)).toContain("forge.json");
  writeFileSync(join(dir, "forge.json"), "{}");
  expect(checkTree(dir)).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});
