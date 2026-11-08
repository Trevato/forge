/** The terminal's Iterations screen: a family's pins as an indented list, for whoever may read it; nothing private to a guest. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { iterationLines, iterationsCommands, iterationsScreen, NO_ITERATIONS_LINE, NOT_FOUND_LINE } from "../src/tui/screens/iterations.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { lanesOf, type IterationBuild } from "../src/core/iterations.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let carol: User;
let game: Repo;
let empty: Repo;
const guest = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-iterations-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mkUser = async (username: string) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  alice = await mkUser("alice");
  const bob = await mkUser("bob");
  carol = await mkUser("carol");
  promote(app.db, bob);
  promote(app.db, carol);
  const commit = async (repo: Repo, who: User, message: string) => {
    const c = await commitToBranch(app, who, repo, { branch: repo.defaultBranch, message, files: [{ path: `${message}.txt`, content: `${message}\n` }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    return c.value.commitOid;
  };
  const pin = async (repo: Repo, who: User, label: string, oid: string, parent?: string) => {
    const p = await pinBuild(app, who, repo, { label, oid, ...(parent === undefined ? {} : { parent }) });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
  };
  const made = await createRepo(app, alice, { name: "game", visibility: "public" });
  const quiet = await createRepo(app, alice, { name: "empty", visibility: "public" });
  if (!made.ok || !quiet.ok) throw new Error("repos");
  game = made.value;
  empty = quiet.value;
  await pin(game, alice, "v1", await commit(game, alice, "one"));
  await pin(game, alice, "v2", await commit(game, alice, "two"), "v1");
  const hush = await forkRepo(app, carol, game, "hush", { visibility: "private" });
  if (!hush.ok) throw new Error(String(hush.error));
  await pin(hush.value, carol, "hidden-pin", await commit(hush.value, carol, "h"), "alice/game:v2");
  const open = await forkRepo(app, bob, game, "open");
  if (!open.ok) throw new Error(String(open.error));
  await pin(open.value, bob, "shown-pin", await commit(open.value, bob, "o"), "alice/game:v1");
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function drive(repo: Repo, user: User | undefined): Promise<string> {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, user ? { ...guest, user } : guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(iterationsScreen(session, tui.ctx, repo));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("iterationLines indents a run under the one it grew from", () => {
  const b = (label: string, parent: string | null): IterationBuild => ({
    key: `a/g:${label}`, label, oid: "a".repeat(40), at: "2026-01-02T00:00:00Z", note: "", parent, edge: parent === null ? null : "git",
    repo: "a/g", branch: "", by: "alice", notes: [], tag: "", forkHas: { branch: null, tagged: false }, plays: "none", page: "/", preview: false, canNote: false,
  });
  const lines = iterationLines(lanesOf([{ repo: "a/g", name: "g", depth: 0, tips: [], forkOf: null, builds: [b("v1", null), b("v2", "a/g:v1"), b("side", "a/g:v1")] }]));
  expect(lines.map((l) => [l.depth, l.head, l.text.split("  ")[0]])).toEqual([
    [0, true, "g"],
    [1, false, "v1"],
    [1, false, "v2"],
    [1, true, "g · branch"],
    [2, false, "side"],
  ]);
});

test("a reader sees the family's runs and builds; a guest sees what is public only", async () => {
  const mine = await drive(game, carol);
  for (const word of ["v1", "v2", "shown-pin", "hidden-pin"]) expect(mine).toContain(word);
  const seen = await drive(game, undefined);
  for (const word of ["v1", "v2", "shown-pin"]) expect(seen).toContain(word);
  expect(seen).not.toContain("hidden-pin");
  expect(seen).not.toContain("hush");
});

test("a family with no pin says so", async () => {
  expect(await drive(empty, undefined)).toContain(NO_ITERATIONS_LINE);
});

test("a private repository reads as not found to a guest, and is not offered", async () => {
  const hush = getRepo(app.db, "carol", "hush")!;
  const text = await drive(hush, undefined);
  expect(text).toContain(NOT_FOUND_LINE);
  expect(text).not.toContain("hidden-pin");
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  expect(iterationsCommands(session, tui.ctx, hush)).toEqual([]);
  expect(iterationsCommands(session, tui.ctx, game).map((c) => c.id)).toEqual(["iterations"]);
});
