/**
 * The terminal's conflict screen does what its keys say (#8354): on a pull
 * whose one file conflicts in two blocks, `o`/`t`/`b`/`e` settle a block each,
 * the file's row counts them, `f` commits the merged file to the pull's
 * branch, and leaving without `f` commits nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { pullStatus, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;
let alice: User;
let n = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-conflicts-"));
  forge = createApp({ dataDir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
}, 30_000);

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Four untouched lines apart, so git keeps the two edits as two blocks. */
const file = (one: string, two: string): string =>
  ["head", one, "keep 1", "keep 2", "keep 3", "keep 4", two, "tail", ""].join("\n");

async function commit(repo: Repo, branch: string, content: string, base?: string): Promise<void> {
  const r = await commitToBranch(forge, alice, repo, {
    branch,
    ...(base ? { base } : {}),
    message: `Write a.txt on ${branch}`,
    files: [{ path: "a.txt", content }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

/** A pull whose a.txt conflicts with main in two blocks. */
async function conflicted(): Promise<{ repo: Repo; pull: Pull; dir: string }> {
  const made = await createRepo(forge, alice, { name: `clash${++n}`, visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  await commit(repo, "main", file("one", "two"));
  await commit(repo, "feature", file("feature one", "feature two"), "main");
  await commit(repo, "main", file("main one", "main two"));
  const opened = await openPull(forge, alice, repo, {
    title: "Clash",
    body: "",
    baseBranch: "main",
    headBranch: "feature",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return { repo, pull: opened.value, dir: repoDir(forge.reposRoot, repo.ownerName, repo.name) };
}

/** The file as committed on a branch. */
function show(dir: string, branch: string): string {
  const r = Bun.spawnSync(["git", "-C", dir, "show", `${branch}:a.txt`]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

/** The pull screen, open on `pull`, with `v` pressed: the conflict screen. */
async function openConflicts(repo: Repo, pull: Pull, rows = 60) {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
    { terminal: headlessTerminal(120, rows), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.ctx.push(pullScreen(session, app.ctx, local(session, repo), pull.number));
  await settleUntil(app, "conflicts");
  const press = async (...keys: string[]): Promise<string> => {
    for (const key of keys) {
      const ctrl = key.startsWith("ctrl+");
      app.dispatch({ type: "key", key: ctrl ? key.slice(5) : key, ctrl, alt: false, shift: false });
      await settleApp(app);
    }
    return app.screen.toText();
  };
  const type = async (text: string): Promise<void> => {
    for (const ch of text) app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  await press("v");
  await settleUntil(app, "conflict block");
  return { app, press, type, text: () => app.screen.toText() };
}

test("o on the first block and t on the second, then f, commits ours-then-theirs", async () => {
  const { repo, pull, dir } = await conflicted();
  const h = await openConflicts(repo, pull);
  expect(h.text()).toContain("2 conflict blocks in 1 file");
  expect(h.text()).toContain("a.txt · 0 of 2 resolved");

  expect(await h.press("o")).toContain("a.txt · 1 of 2 resolved");
  expect(h.text()).toContain("block 1 of 2 · Ours");
  await h.press("n", "t");
  expect(h.text()).toContain("a.txt · 2 of 2 resolved");
  expect(h.text()).toContain("block 2 of 2 · Theirs");

  await h.press("f");
  await settleUntil(h.app, "Conflicts resolved");
  expect(show(dir, "feature")).toBe(file("main one", "feature two"));
  const after = await pullStatus(dir, pull);
  expect(after.conflicts).toEqual([]);
  expect(after.mergeable).toBe(true);
  h.app.stop();
});

test("b and e settle their blocks, and leaving without f commits nothing", async () => {
  const { repo, pull, dir } = await conflicted();
  const before = await pullStatus(dir, pull);
  const h = await openConflicts(repo, pull);

  await h.press("b");
  expect(h.text()).toContain("block 1 of 2 · Both");
  await h.press("n", "e");
  await h.type("mine");
  await h.press("ctrl+d");
  expect(h.text()).toContain("a.txt · 2 of 2 resolved");
  expect(h.text()).toContain("block 2 of 2 · Mine");
  // The merged file beneath: ours then theirs in block one, the typed line in two.
  const merged = h.text().split("Merged file")[1]!.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  expect(merged.slice(0, 9)).toEqual(["head", "main one", "feature one", "keep 1", "keep 2", "keep 3", "keep 4", "mine", "tail"]);

  await h.press("esc");
  expect(h.text()).not.toContain("conflict blocks");
  const after = await pullStatus(dir, pull);
  expect(after.headOid).toBe(before.headOid);
  expect(after.conflicts).toEqual(["a.txt"]);
  expect(show(dir, "feature")).toBe(file("feature one", "feature two"));
  h.app.stop();
});

test("n still brings a block below the fold into view", async () => {
  const { repo, pull } = await conflicted();
  const h = await openConflicts(repo, pull, 10);
  expect(h.text()).not.toContain("block 2 of 2");
  expect(await h.press("n")).toContain("▸ block 2 of 2");
  h.app.stop();
});
