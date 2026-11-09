/**
 * A pull that starts waiting on a named team's review is told once to that
 * team's members (#10164): one line, none for others, none again while it
 * stays held, ended by the team's approval; the team's name is escaped.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { nameTeams } from "../src/actions/issue_teams.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { eventsPage } from "../src/core/events_page.ts";
import type { Pull } from "../src/core/pulls.ts";
import { canRead, type Repo } from "../src/core/repos.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { serve } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let alice: User;
let repo: Repo;
let n = 0;
const user = (name: string): User => getUserByName(app.db, name)!;
const waits = (who: string): string[] =>
  candidatesFor(app.db, user(who), Date.now())
    .map((c) => c.what)
    .filter((w) => w.includes("waits on"));
const events = (kind: string) =>
  app.db.query<{ id: string; payload: string }, [string]>("SELECT id, payload FROM event WHERE kind = ?1").all(kind);

const pullNaming = async (teams: string[], opts: { late?: true; in?: Repo } = {}): Promise<Pull> => {
  const where = opts.in ?? repo;
  const issue = openIssue(app, alice, where, { title: "A chart" });
  if (!issue.ok) throw new Error(issue.error);
  const name = () => {
    const named = nameTeams(app, alice, where, issue.value, teams);
    if (!named.ok) throw new Error(named.error);
  };
  if (opts.late !== true) name();
  const branch = `w${++n}`;
  await commitToBranch(app, alice, where, {
    branch,
    base: "main",
    message: branch,
    files: [{ path: `${branch}.md`, content: "x\n" }],
  });
  const o = await openPull(app, alice, where, {
    title: branch,
    body: `Closes #${issue.value.number}`,
    baseBranch: "main",
    headBranch: branch,
  });
  if (!o.ok) throw new Error(String(o.error));
  if (opts.late === true) name();
  return o.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-feed-team-waits-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  await commitToBranch(app, alice, repo, {
    message: "seed",
    files: [{ path: "README.md", content: "# garden\n" }],
  });
  for (const name of ["quill", "pike"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(app, alice, repo, name);
    seatAs(app.db, repo.id, user(name).id, "reviewer");
  }
  saveTeam(app.db, "design", { charter: "", dial: 0, members: [user("quill").id] });
  saveTeam(app.db, "data-science", { charter: "", dial: 0, members: [user("pike").id] });
}, 120_000);

afterAll(async () => {
  for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
  await Bun.sleep(100);
  app?.close();
  if (dataDir !== "") await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 30_000);

test("members see the wait once, non-members do not, approval ends it", async () => {
  const pull = await pullNaming(["design"]);
  const line = `alice/garden#${pull.number} waits on Design's review`;
  expect(waits("quill")).toEqual([line]);
  expect(waits("pike")).toEqual([]);
  expect(events("pull.team_waiting")).toHaveLength(1);

  // A comment review leaves it held: no second line.
  await submitReview(app, user("pike"), repo, pull, { state: "commented", body: "hm" });
  expect(events("pull.team_waiting")).toHaveLength(1);
  expect(waits("quill")).toEqual([line]);

  // The team approves: the wait is closed.
  const approved = await submitReview(app, user("quill"), repo, pull, { state: "approved" });
  expect(approved.ok).toBe(true);
  expect(events("pull.team_answered")).toHaveLength(1);
  expect(events("pull.team_waiting")).toHaveLength(1);
});

test("naming a team on an already-open pull's issue announces it once", async () => {
  const pull = await pullNaming(["design"], { late: true });
  expect(waits("quill")).toContain(`alice/garden#${pull.number} waits on Design's review`);
  expect(events("pull.team_waiting").filter((e) => e.payload.includes(`"number":${pull.number},`))).toHaveLength(1);
});

test("on a private repository, a member who reads it sees the line and one who cannot does not", async () => {
  const vault = await createRepo(app, alice, { name: "vault", visibility: "private" });
  if (!vault.ok) throw new Error(String(vault.error));
  await commitToBranch(app, alice, vault.value, {
    message: "seed",
    files: [{ path: "README.md", content: "# vault\n" }],
  });
  const agent = await createAgent(app, alice, { username: "moss" });
  if (!agent.ok) throw new Error(String(agent.error));
  // pike is on the vault's crew, so reads it; moss shares the team and is not.
  addToCrew(app, alice, vault.value, "pike");
  seatAs(app.db, vault.value.id, user("pike").id, "reviewer");
  saveTeam(app.db, "data-science", { charter: "", dial: 0, members: [user("pike").id, user("moss").id] });
  expect(canRead(app.db, vault.value, user("pike"))).toBe(true);
  expect(canRead(app.db, vault.value, user("moss"))).toBe(false);
  const pull = await pullNaming(["data-science"], { in: vault.value });
  expect(waits("pike")).toContain(`alice/vault#${pull.number} waits on Data science's review`);
  expect(waits("moss")).toEqual([]);
});

test("the events list shows the wait to the team's members and no other reader", async () => {
  saveTeam(app.db, "design", { charter: "", dial: 0, members: [user("quill").id] });
  const pull = await pullNaming(["design"]);
  const mine = (who: User | undefined) =>
    eventsPage(app.db, repo.id, who, 200).items.filter(
      (e) => e.kind === "pull.team_waiting" && e.payload["number"] === pull.number,
    );
  expect(mine(user("quill"))).toHaveLength(1);
  // pike reads this public repository and is not on Design; alice owns it and is not either.
  expect(mine(user("pike"))).toEqual([]);
  expect(mine(alice)).toEqual([]);
  expect(mine(undefined)).toEqual([]);
});

test("the team's answer is never a post", async () => {
  saveTeam(app.db, "design", { charter: "", dial: 0, members: [user("quill").id] });
  const pull = await pullNaming(["design"]);
  const approved = await submitReview(app, user("quill"), repo, pull, { state: "approved" });
  expect(approved.ok).toBe(true);
  const answered = app.db
    .query<{ id: string }, []>("SELECT id FROM event WHERE kind = 'pull.team_answered'")
    .all()
    .map((e) => `event:${e.id}`);
  expect(answered.length).toBeGreaterThan(0);
  const ids = candidatesFor(app.db, user("quill"), Date.now()).map((c) => c.id);
  expect(ids.some((id) => answered.includes(id))).toBe(false);
});

test("the line is escaped on the page a member reads", async () => {
  const servers = await serve(app);
  try {
    const pull = await pullNaming(["design"]);
    const token = createToken(app.db, user("quill").id, "ro", "ro").token;
    const res = await fetch(`${servers.url}/feed`, { headers: { authorization: `Bearer ${token}` } });
    const page = await res.text();
    // The line is built from the repository's path (a validated slug) and the
    // team's name, which only the migration that seeds teams sets: no door
    // renames a team, so no real path can put < > & or " in it. The
    // apostrophe in "Design's" is the one character a real path reaches.
    expect(page).toContain(`garden#${pull.number} waits on Design&#39;s review`);
    expect(page).not.toContain(`garden#${pull.number} waits on Design's review`);
  } finally {
    await servers.stop();
  }
});
