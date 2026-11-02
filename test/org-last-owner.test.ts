import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  addTeamMember,
  createOrg,
  createTeam,
  isLastOwner,
  isOrgMember,
  lastOwnerSays,
  listOrgsForUser,
  listTeams,
  OWNERS_TEAM,
  ownerlessOrgs,
  personOwners,
  soleOwnedOrgs,
} from "../src/core/orgs.ts";
import { createUser, getUserById, type User } from "../src/core/users.ts";

describe("an organization never loses its last owner", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let carol: User;
  let bot: User;
  let solo: User; // alice alone
  let duo: User; // alice and bob
  let mixed: User; // bob, plus the agent on Owners
  let pair: User; // carol and alice

  const person = async (name: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: name,
      email: `${name}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: false,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const ownersOf = (org: User) =>
    listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;
  const org = (name: string, founder: User): User => {
    const made = createOrg(app.db, name, founder.id);
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-org-last-owner-"));
    app = createApp({ dataDir, port: 0 });
    alice = await person("alice");
    bob = await person("bob");
    carol = await person("carol");
    bot = await person("robot");
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(bot.id);
    bot = getUserById(app.db, bot.id)!;
    expect(bot.kind).toBe("agent");

    solo = org("solo", alice);
    duo = org("duo", alice);
    addTeamMember(app.db, ownersOf(duo), bob.id);
    mixed = org("mixed", bob);
    // addTeamMember refuses an agent on an admin team; a legacy row is
    // written directly, which is what the migration cleans up.
    app.db
      .query("INSERT INTO team_member (team_id, user_id) VALUES (?1, ?2)")
      .run(ownersOf(mixed).id, bot.id);
    pair = org("pair", carol);
    addTeamMember(app.db, ownersOf(pair), alice.id);
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("addTeamMember keeps an agent off the owners team", () => {
    expect(addTeamMember(app.db, ownersOf(solo), bot.id)).toBe(false);
    expect(personOwners(app.db, solo.id)).toEqual([alice.id]);
  });

  test("personOwners lists people only, never an agent", () => {
    expect(personOwners(app.db, mixed.id)).toEqual([bob.id]);
    expect(personOwners(app.db, solo.id)).toEqual([alice.id]);
    expect(personOwners(app.db, duo.id).sort()).toEqual([alice.id, bob.id].sort());
  });

  test("isLastOwner is true for the sole person owner, false once a second owns", () => {
    expect(isLastOwner(app.db, solo.id, alice)).toBe(true);
    expect(isLastOwner(app.db, duo.id, alice)).toBe(false);
    expect(isLastOwner(app.db, duo.id, bob)).toBe(false);
    // An agent beside them does not make them any less the last person.
    expect(isLastOwner(app.db, mixed.id, bob)).toBe(true);
    // The agent is never the last owner, and a non-owner never is.
    expect(isLastOwner(app.db, mixed.id, bot)).toBe(false);
    expect(isLastOwner(app.db, solo.id, carol)).toBe(false);
  });

  test("a second owner ends the sole ownership", async () => {
    const dave = await person("dave");
    const ring = org("ring", dave);
    expect(isLastOwner(app.db, ring.id, dave)).toBe(true);
    addTeamMember(app.db, ownersOf(ring), alice.id);
    expect(isLastOwner(app.db, ring.id, dave)).toBe(false);
    expect(soleOwnedOrgs(app.db, dave.id)).toEqual([]);
    expect(soleOwnedOrgs(app.db, carol.id)).toEqual([]);
  });

  test("soleOwnedOrgs lists exactly the orgs the user alone owns", () => {
    const alices = soleOwnedOrgs(app.db, alice.id).map((o) => o.username);
    expect(alices).toContain("solo");
    expect(alices).not.toContain("duo");
    expect(alices).not.toContain("mixed");
    expect(alices).not.toContain("pair");
    expect(soleOwnedOrgs(app.db, bob.id).map((o) => o.username)).toEqual(["mixed"]);
    expect(soleOwnedOrgs(app.db, bot.id)).toEqual([]);
    expect(soleOwnedOrgs(app.db, "nobody")).toEqual([]);
  });

  test("lastOwnerSays names them in words", () => {
    const said = lastOwnerSays(app.db, "bob");
    expect(said).toBe(
      "bob is the only active person owning mixed: suspending leaves no one to administer it. Make someone else an owner first",
    );
    expect(lastOwnerSays(app.db, "alice")).toContain("owning solo");
  });

  test("isOrgMember and listOrgsForUser agree on membership through any team", () => {
    const devs = createTeam(app.db, duo.id, "devs", "write");
    if (!devs.ok) throw new Error(devs.error);
    addTeamMember(app.db, devs.value, carol.id);
    const everyone = [alice, bob, carol, bot];
    const orgs = [solo, duo, mixed];
    for (const u of everyone) {
      const listed = listOrgsForUser(app.db, u.id).map((o) => o.id);
      for (const o of orgs)
        expect(isOrgMember(app.db, o.id, u.id)).toBe(listed.includes(o.id));
    }
    expect(isOrgMember(app.db, duo.id, carol.id)).toBe(true);
    expect(listOrgsForUser(app.db, carol.id).map((o) => o.username).sort()).toEqual(
      ["duo", "pair"],
    );
    expect(isOrgMember(app.db, solo.id, carol.id)).toBe(false);
    // The legacy agent row still counts as membership, not ownership.
    expect(isOrgMember(app.db, mixed.id, bot.id)).toBe(true);
    expect(listOrgsForUser(app.db, bot.id).map((o) => o.username)).toEqual(["mixed"]);
  });

  // The guard against orphaning an org when the other owner leaves: a
  // suspended or removed owner no longer counts.
  for (const [column, label] of [
    ["suspended_at", "suspended"],
    ["removed_at", "removed"],
  ] as const) {
    test(`a ${label} owner does not count as an owner`, async () => {
      const keep = await person(`keep-${label}`);
      const gone = await person(`gone-${label}`);
      const shared = org(`shared-${label}`, keep);
      addTeamMember(app.db, ownersOf(shared), gone.id);
      expect(personOwners(app.db, shared.id).sort()).toEqual(
        [keep.id, gone.id].sort(),
      );
      expect(isLastOwner(app.db, shared.id, keep)).toBe(false);
      expect(soleOwnedOrgs(app.db, keep.id)).toEqual([]);

      app.db
        .query(`UPDATE user SET ${column} = '2026-01-01T00:00:00Z' WHERE id = ?1`)
        .run(gone.id);
      expect(personOwners(app.db, shared.id)).toEqual([keep.id]);
      expect(isLastOwner(app.db, shared.id, keep)).toBe(true);
      expect(soleOwnedOrgs(app.db, keep.id).map((o) => o.username)).toEqual([
        `shared-${label}`,
      ]);
      expect(lastOwnerSays(app.db, `keep-${label}`)).toContain(
        `only active person owning shared-${label}:`,
      );
      expect(ownerlessOrgs(app.db).map((o) => o.id)).not.toContain(shared.id);

      // With the last one gone too, nobody is left: the org is ownerless.
      app.db
        .query(`UPDATE user SET ${column} = '2026-01-01T00:00:00Z' WHERE id = ?1`)
        .run(keep.id);
      expect(personOwners(app.db, shared.id)).toEqual([]);
      expect(ownerlessOrgs(app.db).map((o) => o.id)).toContain(shared.id);
    });
  }
});
