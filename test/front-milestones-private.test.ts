/**
 * Milestones at the front door never carry a private repository to a guest or
 * to another user: not its lines on `/live/milestones`, not its region at
 * `/app/milestones`, not its wave through `lastWave` (page, list and single
 * JSON, and `lastWaves` itself). The terminal screen reads the same.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { getIssueById, setIssueState, type Issue } from "../src/core/issues.ts";
import { readPlan } from "../src/core/milestones.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { lastWaves } from "../src/story/wave_last.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { mergedPull } from "./helpers/wave-pulls.ts";
import { writeWave } from "../src/story/wave.ts";

quietLogs();

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
const cookies = new Map<string, string>();
const repos = new Map<string, { repo: Repo; goal: Issue }>();

async function build(name: string, visibility: "public" | "private", goalTitle: string, headline: string) {
  let repo = must(await createRepo(app, alice, { name, visibility }));
  const fresh = () => getRepoById(app.db, repo.id)!;
  must(await commitToBranch(app, alice, repo, { message: "init", files: [{ path: "README.md", content: "hi\n" }] }));
  must(createAppRecord(app.db, { repoId: repo.id, slug: name, access: "public" }));
  const open = (title: string): Issue => must(openIssue(app, alice, fresh(), { title }));
  const goal = open(goalTitle);
  const parts = [open(`${name} part a`), open(`${name} part b`)];
  for (const p of parts) must(linkIssue(app, alice, fresh(), getIssueById(app.db, goal.id)!, getIssueById(app.db, p.id)!));
  setIssueState(app.db, parts[0]!.id, "closed", "done");
  const n = await mergedPull(app, alice, repo, `${name} work`);
  app.db.query("UPDATE issue SET body = ? WHERE repo_id = ? AND number = ?").run(`Closes #${parts[0]!.number}`, repo.id, n);
  app.db.query("UPDATE pull SET merged_at = ? WHERE issue_id = (SELECT id FROM issue WHERE repo_id = ? AND number = ?)").run(new Date().toISOString(), repo.id, n);
  const w = writeWave({
    version: "0.1.0",
    date: "2026-03-05",
    headline,
    highlights: [1, 2, 3].map((k) => ({ title: `Thing ${k}`, why: "because" })),
    pulls: [{ title: `#${n} as written`, url: `https://forge.example/alice/${name}/pulls/${n}` }],
  });
  if (!w.ok) throw w.error;
  must(await commitToBranch(app, alice, fresh(), { message: "wave", files: [{ path: "waves/0.1.0.md", content: w.value }] }));
  repo = fresh();
  repos.set(name, { repo, goal });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-front-private-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst: boolean) =>
    must(await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst }));
  alice = await mk("alice", true);
  bob = await mk("bob", false);
  for (const u of [alice, bob]) cookies.set(u.username, `forge_session=${createSession(app.db, u.id).token}; forge_mode=dev`);
  await build("open", "public", "Open goal", "Open wave headline");
  await build("hidden", "private", "Hidden goal", "Hidden wave headline");
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const as = (who: "guest" | "alice" | "bob") => (path: string) =>
  fetch(`${servers.url}${path}`, { headers: who === "guest" ? {} : { cookie: cookies.get(who)! } }).then(async (r) => ({ status: r.status, text: await r.text() }));

const SECRETS = ["Hidden goal", "Hidden wave headline", "hidden part", "/alice/hidden/"];

test("a guest and another user get none of a private repository's lines, region, page or data", async () => {
  const n = repos.get("hidden")!.goal.number;
  for (const who of ["guest", "bob"] as const) {
    const get = as(who);
    const live = await get("/live/milestones");
    expect(live.status).toBe(200);
    for (const s of SECRETS) expect(live.text).not.toContain(s);
    for (const path of ["/alice/hidden/app/milestones", `/alice/hidden/milestones/${n}`, "/alice/hidden/milestones", "/api/v1/repos/alice/hidden/milestones", `/api/v1/repos/alice/hidden/milestones/${n}`]) {
      const got = await get(path);
      expect([path, got.status]).toEqual([path, 404]);
      for (const s of SECRETS) expect(got.text).not.toContain(s);
    }
  }
  // The same doors do answer the one who may read it.
  const mine = await as("alice")("/alice/hidden/app/milestones");
  expect(mine.text).toContain("Hidden goal");
  const page = await as("alice")(`/alice/hidden/milestones/${n}`);
  expect(page.text).toContain("Hidden wave headline");
});

test("a public repository still shows to a guest, without its private neighbour", async () => {
  const live = await as("guest")("/live/milestones");
  expect(live.text).toContain("Open goal");
  expect(live.text).not.toContain("Hidden goal");
});

test("lastWaves answers nothing for a viewer who may not read the repository", async () => {
  const { repo, goal } = repos.get("hidden")!;
  const plan = () => readPlan(app.db, repo, { spend: false, now: new Date() });
  for (const viewer of [undefined, bob]) {
    const got = await lastWaves({ db: app.db, reposRoot: app.reposRoot, repo, viewer, plan });
    expect(got.size).toBe(0);
  }
  const owner = await lastWaves({ db: app.db, reposRoot: app.reposRoot, repo, viewer: alice, plan });
  expect(owner.get(goal.number)?.headline).toBe("Hidden wave headline");
});

test("the terminal's Milestones screen lists the same: a guest the public apps only, the owner both", async () => {
  const screen = async (user: User | undefined) => {
    const terminal = headlessTerminal(140, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app: tui } = createForgeApp(app, identity, { terminal, exitHooks: false });
    tui.start();
    const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    key("k", true);
    await settleApp(tui);
    for (const ch of "Milestones") key(ch);
    await settleApp(tui);
    key("enter");
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop();
    return text;
  };
  const guest = await screen(undefined);
  expect(guest).toContain("Open goal");
  expect(guest).not.toContain("Hidden goal");
  const other = await screen(bob);
  expect(other).not.toContain("Hidden goal");
  const owner = await screen(alice);
  expect(owner).toContain("Hidden goal");
  expect(owner).toContain("1 of 2 done");
});
