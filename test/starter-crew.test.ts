/**
 * A new forge comes with a crew that builds at once (#11154): a builder and
 * a reviewer seated on its apps with autonomy on, the included credit lent
 * through the child credit, one field for the owner's own key, and no
 * promise of a crew when there is neither credit nor key.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow, listAgents, listCrewRoles } from "../src/core/agents.ts";
import { getRepo } from "../src/core/repos.ts";
import { listTeamMembers, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { getUserByName } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { listGrants, listSubscriptions } from "../src/core/subscriptions.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { readCredit } from "../src/spawn/credit.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { fundingOf, keepFunding } from "../src/spawn/funding.ts";
import type { Ctx } from "../src/http/context.ts";
import { crewKeyCard, crewCanRun, includedCredit } from "../src/web/studio/crew_key.ts";
import { saveCrewKey } from "../src/actions/crew_key.ts";
import { FORGE_CODE_NAME } from "../src/spawn/forge_code.ts";
import { hasStarterCrew, seatStarterCrew, seedStarterCrew } from "../src/spawn/starter_crew.ts";
import { worstCaseDailyUsd } from "../src/spawn/included_credit.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a new forge's starter crew", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let servers: Servers;
  let token = "";
  let childDir = "";

  const spawn = async (name: string): Promise<string> => {
    const made = await fetch(`${servers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name, apps: ["alice/bakery"], dryRun: false }),
    });
    if (made.status !== 201) throw new Error(`spawn ${made.status}`);
    return ((await made.json()) as { bodyId: string }).bodyId;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-starter-crew-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-starter-passphrase", isAdmin: true });
    if (!alice.ok) throw new Error("user");
    token = createToken(parent.db, alice.value.id, "rw", "rw").token;
    const repo = await createRepo(parent, alice.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [
        { path: "README.md", content: "# bakery\n" },
        { path: "forge.json", content: JSON.stringify({ app: { run: "bun run index.ts" } }) },
      ],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    servers = await serve(parent);
    childDir = childDirOf(parent, await spawn("maria"));
    child = createApp({ dataDir: childDir, port: 0 });
    await firstBoot(child);
  });

  afterAll(async () => {
    servers?.stop();
    child?.close();
    parent?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("it has a builder and a reviewer, seated on its app, autonomy on", () => {
    expect(listAgents(child.db).map((a) => a.user.username).sort()).toEqual(["builder", "reviewer"]);
    const repo = getRepo(child.db, "maria", "bakery")!;
    expect(listCrewRoles(child.db, repo.id).map((c) => c.role).sort()).toEqual(["builder", "reviewer"]);
    expect(repo.autonomy).toBe("autonomous");
    expect(repo.autonomyBy).not.toBeNull();
  });

  test("it is lent the plan's included credit once, with no key of its own", () => {
    expect(readCredit(parent, "maria")?.capUsd).toBe(2);
    expect(fundingOf(childDir)?.capUsd).toBe(2);
    expect(listSubscriptions(child.db)).toEqual([]);
    expect(includedCredit(child)).toEqual({ capUsd: 2, leftUsd: 2 });
    expect(crewCanRun(child)).toBe(true);
  });

  test("spent credit and no key: the crew cannot run, and the page says what is needed", () => {
    keepFunding(childDir, { token: fundingOf(childDir)!.token, capUsd: 2, spentUsd: 2 });
    expect(crewCanRun(child)).toBe(false);
    expect(includedCredit(child)?.leftUsd).toBe(0);
  });

  test("the key card says what is needed, once, and never calls it a subscription", () => {
    const ctx = { app: child, auth: { user: { isAdmin: true } } } as unknown as Ctx;
    const spent = String(crewKeyCard(ctx));
    expect(spent).toContain("included credit is spent");
    expect(spent).toContain('name="token"');
    expect(spent.toLowerCase()).not.toContain("subscription");
    keepFunding(childDir, { token: fundingOf(childDir)!.token, capUsd: 2, spentUsd: 0.5 });
    expect(String(crewKeyCard(ctx))).toContain("$1.50 of $2 included credit");
  });

  test("a repository made later in the forge is seated and autonomous too", async () => {
    const owners = listTeams(child.db, getUserByName(child.db, "maria")!.id).find((t) => t.name === OWNERS_TEAM)!;
    const founder = listTeamMembers(child.db, owners.id)[0]!;
    const made = await createRepo(child, founder, { name: "second", owner: "maria" });
    if (!made.ok) throw new Error(`repo ${made.error}`);
    expect(listCrewRoles(child.db, made.value.id).map((c) => c.role).sort()).toEqual(["builder", "reviewer"]);
    expect(getRepo(child.db, "maria", "second")!.autonomy).toBe("autonomous");
  });

  test("a forge brought its own key is lent nothing; 0 turns the credit off", async () => {
    setLimit(parent.db, "spawn.included_credit_usd", 0, parent.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id);
    await spawn("nolend");
    expect(readCredit(parent, "nolend")).toBeUndefined();
  });

  test("the worst case a day is the visitor limit times the credit", () => {
    expect(worstCaseDailyUsd(parent)).toBe(0);
  });

  test("seatStarterCrew leaves the forge's own code to adoptForgeCode, and a person's autonomy choice alone", async () => {
    const owners = listTeams(child.db, getUserByName(child.db, "maria")!.id).find((t) => t.name === OWNERS_TEAM)!;
    const founder = listTeamMembers(child.db, owners.id)[0]!;
    // The forge's own code: named FORGE_CODE_NAME, so not seated by the starter crew.
    const code = await createRepo(child, founder, { name: "third", owner: "maria" });
    if (!code.ok) throw new Error(`repo ${code.error}`);
    child.db.query("DELETE FROM repo_crew WHERE repo_id = ?1").run(code.value.id);
    seatStarterCrew(child.db, { ...code.value, name: FORGE_CODE_NAME }, founder.id);
    expect(listCrewRoles(child.db, code.value.id)).toEqual([]);
    // A person chose autonomy off: it stays off though the crew is seated.
    const chosen = await createRepo(child, founder, { name: "fourth", owner: "maria" });
    if (!chosen.ok) throw new Error(`repo ${chosen.error}`);
    child.db.query("UPDATE repo SET autonomy = 'off', autonomy_by = ?2 WHERE id = ?1").run(chosen.value.id, founder.id);
    seatStarterCrew(child.db, getRepo(child.db, "maria", "fourth")!, founder.id);
    expect(getRepo(child.db, "maria", "fourth")!.autonomy).toBe("off");
  });

  test("a forge that already has crew keeps it, and the starter pair is not added", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-has-crew-"));
    const own = createApp({ dataDir, port: 0 });
    try {
      const made = await createUser(own.db, { origin: "seed", trusted: true, username: "zed", email: "z@x.test", password: "a-long-starter-passphrase", isAdmin: true });
      const scribe = await createUser(own.db, { username: "scribe", email: "scribe@x.invalid", agent: true, origin: "seed" });
      if (!made.ok || !scribe.ok) throw new Error("user");
      createAgentRow(own.db, { userId: scribe.value.id, roles: ["builder"], createdBy: made.value.id });
      expect(await seedStarterCrew(own.db, made.value.id, made.value.id)).toBe(false);
      expect(listAgents(own.db).map((a) => a.user.username)).toEqual(["scribe"]);
      expect(hasStarterCrew(own.db, made.value.id)).toBe(false);
    } finally {
      own.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a key saved by the admin is sealed and granted to the owner and the spawned organisation", async () => {
    const owners = listTeams(child.db, getUserByName(child.db, "maria")!.id).find((t) => t.name === OWNERS_TEAM)!;
    const founder = listTeamMembers(child.db, owners.id)[0]!;
    const saved = await saveCrewKey(child, { ...founder, isAdmin: true, kind: "user" }, "  sk-ant-api03-abcdefghij  ");
    expect(saved).toEqual({ ok: true, woken: 0 });
    const subs = listSubscriptions(child.db);
    expect(subs.map((x) => x.name)).toEqual(["my-key"]);
    const org = getUserByName(child.db, "maria")!;
    for (const scope of [founder.id, org.id]) expect(listGrants(child.db, scope).map((g) => g.subscriptionId)).toEqual([subs[0]!.id]);
  });
});
