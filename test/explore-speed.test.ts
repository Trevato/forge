/** /explore's ranking is kept on what it ranks by: warm under 10 ms, fresh on the next change, never shared across readers (#6129). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { explore, parseExploreQuery } from "../src/actions/explore.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createAgent } from "../src/actions/crew.ts";
import { addCrew, removeCrew } from "../src/core/agents.ts";
import { setAppMembers } from "../src/core/app_members.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createUser } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";

let f: SnappyFixture;

beforeAll(async () => {
  f = await snappyFixture();
  for (const repo of f.repos) {
    if (repo.visibility !== "public") continue;
    const made = insertApp(f.app.db, { repoId: repo.id, slug: `${repo.ownerName}-${repo.name}`, access: "public" });
    if (!made.ok) throw new Error(made.error);
  }
}, 120_000);
afterAll(async () => {
  await f.close();
});

const all = parseExploreQuery("");
const byForks = parseExploreQuery("kind:app sort:forks");
const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name);

async function app(owner: typeof f.owner, name: string, access: "public" | "private") {
  const repo = await createRepo(f.app, owner, { name, visibility: access });
  if (!repo.ok) throw new Error(String(repo.error));
  const made = insertApp(f.app.db, { repoId: repo.value.id, slug: `${owner.username}-${name}`, access });
  if (!made.ok) throw new Error(made.error);
  return repo.value;
}

test("a warm rank is under 10 ms, even after a write the ranking does not read", async () => {
  await explore(f.app, undefined, all);
  const warm: number[] = [];
  const busy: number[] = [];
  for (let i = 0; i < 5; i++) {
    let t = performance.now();
    await explore(f.app, undefined, all);
    warm.push(performance.now() - t);
    createSession(f.app.db, f.peer.id); // moves the write clock; ranks nothing
    t = performance.now();
    await explore(f.app, undefined, all);
    busy.push(performance.now() - t);
  }
  expect(Math.min(...warm)).toBeLessThan(10);
  expect(Math.min(...busy)).toBeLessThan(10);
});

test("an unrelated write does not rank again", async () => {
  const before = await explore(f.app, undefined, all);
  expect(before.length).toBeGreaterThan(3);
  createSession(f.app.db, f.peer.id);
  // Kept rows are shared objects: the same row back means it was not ranked again.
  expect((await explore(f.app, undefined, all))[0]).toBe(before[0]);
});

test("a new fork reorders the list on the next request", async () => {
  await explore(f.app, undefined, byForks);
  const last = (await explore(f.app, undefined, byForks)).at(-1)!;
  const parent = f.repos.find((r) => `${r.ownerName}/${r.name}` === last.name);
  if (parent === undefined) throw new Error(`no repo for ${last.name}`);
  const first = names(await explore(f.app, undefined, byForks))[0];
  expect(first).not.toBe(last.name);
  for (const n of ["a", "b"]) {
    const fork = await createRepo(f.app, f.peer, { name: `fork-of-last-${n}`, visibility: "public" });
    if (!fork.ok) throw new Error(String(fork.error));
    f.app.db.query("UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2").run(parent.id, fork.value.id);
  }
  expect(names(await explore(f.app, undefined, byForks))[0]).toBe(last.name);
});

test("a private app is never served from an entry built for a viewer who could not read it", async () => {
  const peer = f.peer;
  const secret = await app(peer, "secret-garden", "private");
  const name = `${peer.username}/${secret.name}`;
  // Stranger first, then the owner, then the stranger again: every order.
  expect(names(await explore(f.app, undefined, all))).not.toContain(name);
  expect(names(await explore(f.app, peer, all))).toContain(name);
  expect(names(await explore(f.app, undefined, all))).not.toContain(name);
  expect(names(await explore(f.app, f.owner, all))).toContain(name);
  // The other direction: the owner's entry is warm, then the repository goes public.
  await explore(f.app, peer, all);
  f.app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(secret.id);
  f.app.db.query("UPDATE app SET access = 'public' WHERE repo_id = ?1").run(secret.id);
  expect(names(await explore(f.app, undefined, all))).toContain(name);
  f.app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(secret.id);
  expect(names(await explore(f.app, undefined, all))).not.toContain(name);
});

// Grants canEnterApp reads (#6129): each is warmed in the viewer's entry, changed, and the next answer must follow.
async function guest(username: string, kind: "user" | "agent" = "user") {
  if (kind === "agent") {
    const made = await createAgent(f.app, f.owner, { username });
    if (!made.ok) throw new Error(String(made.error));
    return made.value.user;
  }
  const made = await createUser(f.app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: false,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

/** A private app of the peer's, awake for three hours, and what `viewer` is told about its use. */
async function awakePrivate(name: string) {
  const repo = await app(f.peer, name, "private");
  f.app.db
    .query(
      `INSERT INTO meter (repo_id, env, placement, started_at, beat_at) VALUES (?1, 'production', 'owned', ?2, ?2)`,
    )
    .run(repo.id, new Date(Date.now() - 3 * 3_600_000).toISOString());
  const hours = async (viewer: typeof f.owner) =>
    (await explore(f.app, viewer, parseExploreQuery(`kind:app ${name}`))).find((r) => r.name === `${f.peer.username}/${name}`)
      ?.numbers.awakeHours;
  return { repo, hours };
}

test("removing a crew seat takes the app's use from the agent's next answer", async () => {
  const bot = await guest("bot-seat", "agent");
  const { repo, hours } = await awakePrivate("crew-seat");
  expect(await hours(bot)).toBeUndefined(); // an agent not on the crew cannot read it at all
  f.app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(repo.id);
  expect(await hours(bot)).toBe(0);
  expect(addCrew(f.app.db, repo.id, bot.id)).toBe(true);
  expect(await hours(bot)).toBeGreaterThan(2);
  expect(await hours(bot)).toBeGreaterThan(2);
  removeCrew(f.app.db, repo.id, bot.id);
  expect(await hours(bot)).toBe(0);
});

test("naming and un-naming a person changes what their next answer tells", async () => {
  const carol = await guest("carol-named");
  const { repo, hours } = await awakePrivate("named-app");
  f.app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(repo.id);
  const record = f.app.db.query<{ id: string }, [string]>("SELECT id FROM app WHERE repo_id = ?1").get(repo.id)!;
  expect(await hours(carol)).toBe(0);
  setAppMembers(f.app.db, record.id, [carol.id], f.peer.id);
  expect(await hours(carol)).toBeGreaterThan(2);
  expect(await hours(carol)).toBeGreaterThan(2);
  setAppMembers(f.app.db, record.id, [], f.peer.id);
  expect(await hours(carol)).toBe(0);
});

test("a team's permission and membership change the next answer of the org's member", async () => {
  const dana = await guest("dana-team");
  const org = createOrg(f.app.db, "teamwork", f.owner.id);
  if (!org.ok) throw new Error(org.error);
  const { repo } = await awakePrivate("org-app");
  f.app.db.query("UPDATE repo SET owner_id = ?1, visibility = 'public' WHERE id = ?2").run(org.value.id, repo.id);
  const team = createTeam(f.app.db, org.value.id, "builders", "read");
  if (!team.ok) throw new Error(team.error);
  const name = `teamwork/org-app`;
  const seen = async () =>
    (await explore(f.app, dana, parseExploreQuery("kind:app org-app"))).find((r) => r.name === name)?.numbers.awakeHours;
  expect(await seen()).toBe(0);
  addTeamMember(f.app.db, team.value, dana.id);
  expect(await seen()).toBe(0); // read only: still not told
  f.app.db.query("UPDATE team SET permission = 'write' WHERE id = ?1").run(team.value.id);
  expect(await seen()).toBeGreaterThan(2);
  expect(await seen()).toBeGreaterThan(2);
  f.app.db.query("DELETE FROM team_member WHERE team_id = ?1").run(team.value.id);
  expect(await seen()).toBe(0);
});
