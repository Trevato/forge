/**
 * An organization always keeps an owner who is a person (#722). An agent
 * never owns one — it is never admin (CLAUDE.md, invariant 10) — so it is
 * neither added to a team that confers admin nor counted as the owner that
 * keeps the organization alive. Removing the last person who owns it is
 * refused on every route, and so is removing their account; the migration
 * takes every agent out of Owners on upgrade and says so in the outbox.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAccount } from "../src/actions/accounts.ts";
import { createAgent } from "../src/actions/crew.ts";
import {
  addTeamMember,
  createOrg,
  createTeam,
  removeTeamMember,
} from "../src/actions/orgs.ts";
import { createApp, type App } from "../src/app.ts";
import { listTeams, OWNERS_TEAM, type Team } from "../src/core/orgs.ts";
import { migrations } from "../src/core/schema.ts";
import { idFloor } from "../src/kernel/id.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("an organization always keeps a person who owns it", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let bot: User;
  let acme: User;
  let owners: Team;
  let adminToken = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-org-owners-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const people: User[] = [];
    for (const [name, first] of [
      ["alice", true],
      ["bob", false],
    ] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, bob] = people as [User, User];
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;
    // Bob founds acme: the one person who owns it.
    const org = createOrg(app, bob, "acme");
    if (!org.ok) throw new Error(String(org.error));
    acme = org.value;
    owners = listTeams(app.db, acme.id).find((t) => t.name === OWNERS_TEAM)!;
    adminToken = createToken(app.db, bob.id, "t", "admin").token;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const members = (team: Team) =>
    (
      app.db
        .query("SELECT user_id FROM team_member WHERE team_id = ?1")
        .all(team.id) as { user_id: string }[]
    ).map((r) => r.user_id);

  // ── refusals ──────────────────────────────────────────────────────────

  test("an agent is never added to Owners, nor to any team that confers admin", async () => {
    const owner = addTeamMember(app, bob, acme, owners, "bot");
    expect(owner.ok).toBe(false);
    if (!owner.ok) expect(owner.error).toBe("agent_cannot_own");
    const admins = createTeam(app, bob, acme, "Stewards", "admin");
    if (!admins.ok) throw new Error(String(admins.error));
    const team = admins.value;
    const steward = addTeamMember(app, bob, acme, team, "bot");
    expect(steward.ok).toBe(false);
    // The API answers the same, explicitly.
    const res = await fetch(
      `${base}/api/v1/orgs/acme/teams/Owners/members`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ user: "bot" }),
      },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toBe("agent_cannot_own");
    expect(members(owners)).not.toContain(bot.id);
  });

  test("an agent cannot found an organization: its founder would be its owner", () => {
    const made = createOrg(app, bot, "botco");
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error).toBe("agent_cannot_own");
    expect(getUserByName(app.db, "botco")).toBeUndefined();
  });

  test("an agent seeded into Owners does not count: the last person cannot be removed", async () => {
    app.db.run("INSERT INTO team_member (team_id, user_id) VALUES (?1, ?2)", [
      owners.id,
      bot.id,
    ]);
    const removed = removeTeamMember(app, bob, acme, owners, "bob");
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error).toBe("last_owner");
    const res = await fetch(
      `${base}/api/v1/orgs/acme/teams/Owners/members/bob`,
      { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("last_owner");
    expect(members(owners)).toContain(bob.id);
    app.db.run("DELETE FROM team_member WHERE team_id = ?1 AND user_id = ?2", [
      owners.id,
      bot.id,
    ]);
  });

  test("an account that is the only person owning an organization is not removed, and nothing changes", async () => {
    const done = await removeAccount(app, alice, "bob");
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toBe("last_owner");
    const still = getUserByName(app.db, "bob")!;
    expect(still.removedAt).toBeNull();
    expect(still.suspendedAt).toBeNull();
    const aliceToken = createToken(app.db, alice.id, "t", "admin").token;
    const res = await fetch(`${base}/api/v1/admin/accounts/bob`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(409);
    const out = (await res.json()) as any;
    expect(out.error).toBe("last_owner");
    expect(out.message).toContain("acme");
  });

  test("the accounts page names the organizations an account is the only owner of", async () => {
    const signin = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${base}/settings/accounts`, { headers: { cookie } })
    ).text();
    expect(page).toContain("only owner of");
    expect(page).toContain("acme");
  });

  test("a suspended owner does not count: the last active person cannot be removed, nor their account", async () => {
    // Ann owns acme with Bob; then Bob is suspended.
    const ann = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "ann",
      email: "ann@forge.local",
      password: "a-good-passphrase",
    });
    if (!ann.ok) throw new Error(ann.error);
    expect(addTeamMember(app, bob, acme, owners, "ann").ok).toBe(true);
    app.db.run("UPDATE user SET suspended_at = ?2 WHERE id = ?1", [
      bob.id,
      new Date().toISOString(),
    ]);
    const removed = removeTeamMember(app, alice, acme, owners, "ann");
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error).toBe("last_owner");
    const account = await removeAccount(app, alice, "ann");
    expect(account.ok).toBe(false);
    if (!account.ok) expect(account.error).toBe("last_owner");
    // The suspended owner can be taken off: an active one stays.
    expect(removeTeamMember(app, alice, acme, owners, "bob").ok).toBe(true);
    app.db.run("UPDATE user SET suspended_at = NULL WHERE id = ?1", [bob.id]);
    expect(addTeamMember(app, alice, acme, owners, "bob").ok).toBe(true);
    expect(removeTeamMember(app, alice, acme, owners, "ann").ok).toBe(true);
  });

  test("with a second person owning it, the first is removed and the organization keeps an owner", async () => {
    const added = addTeamMember(app, bob, acme, owners, "alice");
    expect(added.ok).toBe(true);
    const removed = removeTeamMember(app, bob, acme, owners, "bob");
    expect(removed.ok).toBe(true);
    expect(members(owners)).toEqual([alice.id]);
  });

  test("the upgrade takes every agent out of Owners and records each in the outbox", () => {
    app.db.run("INSERT INTO team_member (team_id, user_id) VALUES (?1, ?2)", [
      owners.id,
      bot.id,
    ]);
    const ddl = migrations.find((m) => m.includes("an agent never owns"));
    expect(ddl).toBeString();
    const last = (
      app.db.query("SELECT id FROM event ORDER BY id DESC LIMIT 1").get() as {
        id: string;
      }
    ).id;
    // The migration stamps its id from SQLite's wall clock; `id()` is
    // monotonic per process, so a suite earlier in the same process that
    // moved `Date.now` ahead (`api-forge-view.test.ts`) leaves it ahead of
    // the wall. The bound is the last event or the wall clock, whichever is
    // older: with an honest clock that is the last event, as before.
    const wall = idFloor(Date.now());
    const before = last < wall ? last : wall;
    app.db.exec(ddl!);
    expect(members(owners)).not.toContain(bot.id);
    expect(members(owners)).toContain(alice.id);
    const recorded = app.db
      .query(
        "SELECT id, payload FROM event WHERE kind = 'team.member_removed' AND payload LIKE '%\"bot\"%'",
      )
      .all() as { id: string; payload: string }[];
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]!.payload)).toMatchObject({
      org: "acme",
      user: "bot",
    });
    // Its id is never older than any event before it, as an outbox id must
    // not be. Within one millisecond two ids order by their random part, so
    // it is the time the id carries (its first ten characters) that is held.
    expect(recorded[0]!.id.slice(0, 10) >= before.slice(0, 10)).toBe(true);
    // Run twice, it finds nothing more to do.
    app.db.exec(ddl!);
    expect(
      (
        app.db
          .query(
            "SELECT count(*) AS n FROM event WHERE kind = 'team.member_removed' AND payload LIKE '%\"bot\"%'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });
});
