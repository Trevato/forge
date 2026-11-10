/** Milestones at the front door (#1083): live lines, the wave that moved one, and the data's `movedThisWeek` and `lastWave`. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { getIssueById, setIssueState, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mergedPull, waveNaming } from "./helpers/wave-pulls.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let cookie: string;
let repo: Repo;
let goal: Issue;
let quiet: Issue;
const fresh = () => getRepoById(app.db, repo.id)!;
const open = (title: string): Issue => must(openIssue(app, alice, fresh(), { title }));
const link = (waiter: Issue, on: Issue): void => {
  must(linkIssue(app, alice, fresh(), getIssueById(app.db, waiter.id)!, getIssueById(app.db, on.id)!));
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-front-ms-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  alice = must(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@f.dev",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=dev`;
  repo = must(await createRepo(app, alice, { name: "plan", visibility: "public" }));
  must(await commitToBranch(app, alice, repo, { message: "init", files: [{ path: "README.md", content: "hi\n" }] }));
  must(createAppRecord(app.db, { repoId: repo.id, slug: "plan", access: "public" }));
  goal = open("Ship the front door");
  const parts = [open("Part A"), open("Part B"), open("Part C")];
  for (const p of parts) link(goal, p);
  setIssueState(app.db, parts[0]!.id, "closed", "done");
  const n = await mergedPull(app, alice, repo, "Part A work");
  app.db.query("UPDATE issue SET body = ? WHERE repo_id = ? AND number = ?").run(`Closes #${parts[0]!.number}`, repo.id, n);
  // It merged just now: what landed this week.
  app.db.query("UPDATE pull SET merged_at = ? WHERE issue_id = (SELECT id FROM issue WHERE repo_id = ? AND number = ?)").run(new Date().toISOString(), repo.id, n);
  must(
    await commitToBranch(app, alice, fresh(), {
      message: "wave",
      files: [{ path: "waves/0.1.0.md", content: waveNaming("0.1.0", [{ owner: "alice", name: "plan", number: n }]) }],
    }),
  );
  // A milestone with open work and nothing landed: it has no wave.
  quiet = open("Quiet goal");
  link(quiet, open("Quiet part"));
}, 60_000);

afterAll(() => {
  servers.stop();
  app.close();
});

const get = (path: string, auth = true) =>
  fetch(`${servers.url}${path}`, { headers: auth ? { cookie } : {} }).then((r) => r.text());

test("the home and an app's page carry live lines: name, done of total, moved this week", async () => {
  for (const [path, src] of [
    ["/?all=1", "/live/milestones"],
    ["/alice/plan/app", "/alice/plan/app/milestones"],
  ] as const) {
    const text = await get(path);
    expect(text).toContain(`data-live-src="${src}"`);
    expect(text).toContain("Ship the front door");
    expect(text).toContain("1 of 3 done");
    expect(text).toContain("1 landed in 7 days");
  }
  const live = await get("/live/milestones");
  expect(live).toContain(`/alice/plan/milestones/${goal.number}`);
  // Biggest by open work first; the one that moved nothing says so.
  expect(live.indexOf("Ship the front door")).toBeLessThan(live.indexOf("Quiet goal"));
  expect(live).toContain("quiet this week");
  // A milestone with no estimate leaves no dangling separator.
  expect(live).not.toMatch(/·\s*<\/span>/);
  expect(live).not.toMatch(/·\s*$/m);
});

test("a visitor sees a public repository's milestones, without spend", async () => {
  const text = await get("/alice/plan/app/milestones", false);
  expect(text).toContain("Ship the front door");
  expect(text).not.toMatch(/\$\d/);
});

test("a region paints nothing when nothing moved", async () => {
  const empty = await get("/alice/plan/app/milestones").then((t) => t.includes("row-title"));
  expect(empty).toBe(true);
  app.db.query("UPDATE pull SET merged_at = '2020-01-01T00:00:00.000Z'").run();
  expect(await get("/live/milestones")).not.toContain("row-title");
});

test("the milestone page links back to the wave that moved it; one no wave moved has none", async () => {
  const page = await get(`/alice/plan/milestones/${goal.number}`);
  expect(page).toContain(`id="ms-wave"`);
  expect(page).toContain(`href="/alice/plan/waves/0.1.0"`);
  expect(await get(`/alice/plan/milestones/${quiet.number}`)).not.toContain("ms-wave");
});

test("the data carries movedThisWeek and the last wave per milestone", async () => {
  const list = JSON.parse(await get("/api/v1/repos/alice/plan/milestones"));
  const limb = list.items.find((l: { number: number }) => l.number === goal.number);
  expect(limb.movedThisWeek).toBeNumber();
  expect(limb.lastWave.version).toBe("0.1.0");
  const one = JSON.parse(await get(`/api/v1/repos/alice/plan/milestones/${goal.number}`));
  expect(one.lastWave.href).toBe("/alice/plan/waves/0.1.0");
  const none = JSON.parse(await get(`/api/v1/repos/alice/plan/milestones/${quiet.number}`));
  expect(none.lastWave).toBeUndefined();
});

test("the waves are read from git once per latest event, and a push shows at once", async () => {
  const { lastWaves } = await import("../src/story/wave_last.ts");
  const { readPlan } = await import("../src/core/milestones.ts");
  const input = { db: app.db, reposRoot: app.reposRoot, repo: fresh(), viewer: alice, plan: () => readPlan(app.db, fresh(), { spend: false, now: new Date() }) };
  const first = await lastWaves(input);
  expect(first.get(goal.number)?.version).toBe("0.1.0");
  // Unchanged repository: the same kept answer, no read of the tree.
  const again = await lastWaves(input);
  expect(again.get(goal.number)).toEqual(first.get(goal.number)!);
  // A newer wave naming the same pull: a push is an event, so the next read sees it.
  const naming = waveNaming("0.2.0", [{ owner: "alice", name: "plan", number: Number(app.db.query<{ number: number }, [string]>("SELECT MAX(number) AS number FROM issue WHERE repo_id = ? AND id IN (SELECT issue_id FROM pull)").get(repo.id)!.number) }]);
  must(await commitToBranch(app, alice, fresh(), { message: "wave 2", files: [{ path: "waves/0.2.0.md", content: naming }] }));
  const after = await lastWaves({ ...input, repo: fresh() });
  expect(after.get(goal.number)?.version).toBe("0.2.0");
});
