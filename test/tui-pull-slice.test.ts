/**
 * The terminal's pull screen lands a fork's pull in slices with `S`: offered
 * to a person who may write on an open pull from a fork, and to no one else;
 * picking a commit lands the author's commits up to it (#9010).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-slice-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function person(username: string, adminIfFirst = false): Promise<User> {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
}

async function commit(user: User, repo: Repo, branch: string, path: string): Promise<string> {
  const c = await commitToBranch(app, user, repo, {
    branch,
    message: `add ${path}`,
    files: [{ path, content: `${path}\n` }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  return (await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), `refs/heads/${branch}`))!;
}

test("S is offered to a writer on an open fork pull, to no agent, reader or branch pull; a pick lands the slice", async () => {
  const alice = await person("alice", true);
  const bob = await person("bob");
  promote(app.db, bob);
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  let repo = r.value;
  await commit(alice, repo, "main", "seed.md");
  const forked = await forkRepo(app, bob, repo);
  if (!forked.ok) throw new Error(String(forked.error));
  const fork = forked.value;
  const mine = [await commit(bob, fork, "main", "x.md"), await commit(bob, fork, "main", "y.md")];
  const fromFork = await openPull(app, bob, repo, {
    title: "Bob's work",
    body: "",
    baseBranch: "main",
    headBranch: "main",
    headRepo: fork,
  });
  if (!fromFork.ok) throw new Error(String(fromFork.error));
  await commit(alice, repo, "feat", "feat.md");
  const own = await openPull(app, alice, repo, {
    title: "Alice's branch",
    body: "",
    baseBranch: "main",
    headBranch: "feat",
  });
  if (!own.ok) throw new Error(String(own.error));
  const agent = await createAgent(app, alice, { username: "bot" });
  if (!agent.ok) throw new Error(String(agent.error));
  repo = getRepoById(app.db, repo.id)!;

  const open = async (user: User, number: number) => {
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
      { terminal: headlessTerminal(160, 44), exitHooks: false },
    );
    tui.start();
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), number));
    await settleApp(tui);
    const press = async (...keys: string[]) => {
      for (const key of keys)
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    return { tui, press, text: () => tui.screen.toText() };
  };
  const picker = (n: number) => `Land #${n} up to`;
  const number = fromFork.value.number;

  // Not an agent, not the author who cannot write here, not a branch of the repository.
  for (const [who, n] of [
    [getUserByName(app.db, "bot")!, number],
    [bob, number],
    [alice, own.value.number],
  ] as const) {
    const s = await open(who, n);
    try {
      await s.press("S");
      expect(s.text()).not.toContain(picker(n));
    } finally {
      s.tui.stop();
    }
  }

  const s = await open(alice, number);
  try {
    await s.press("S");
    expect(s.text()).toContain(picker(number));
    expect(s.text()).toContain(mine[0]!.slice(0, 7));
    expect(s.text()).toContain("head: the last slice");
    // Oldest first: enter takes the first of the author's commits.
    await s.press("enter");
    expect(s.text()).toContain("slice landed, 1 left");
  } finally {
    s.tui.stop();
  }
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = (await resolveOid(dir, "refs/heads/main"))!;
  const parents = (await Bun.$`git -C ${dir} log -1 --format=%P ${tip}`.text()).trim().split(" ");
  expect(parents[1]).toBe(mine[0]!);
  expect(getPull(app.db, repo.id, number)!.mergedAt).toBeNull();
}, 60_000);
