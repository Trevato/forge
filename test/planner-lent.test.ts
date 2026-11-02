/**
 * A repository in auto mode with a direction and no planner gets one, and
 * its first planned issues start without a further step (#7637).
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { crewRole } from "../src/core/agents.ts";
import { getIssueById } from "../src/core/issues.ts";
import { createRepo as coreCreateRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { visionLines } from "../src/tui/screens/vision.ts";
import { NO_VISION } from "../src/core/vision.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { directionStall, ensurePlanner } from "../src/crew/planner.ts";

describe("a migrated repository with only a builder", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let pixel: Repo;
  let servers: Servers;
  let cookie: string;
  const fresh = () => getRepoById(app.db, pixel.id)!;

  async function repo(name: string): Promise<Repo> {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    return made.value;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-lent-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    servers = await serve(app);
    for (const name of ["atlas", "torque"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
    }
    // Elsewhere on the forge atlas plans.
    const home = await repo("home");
    expect(addToCrew(app, alice, home, "atlas").ok).toBe(true);
    seatAs(app.db, home.id, getUserByName(app.db, "atlas")!.id, "planner");
    // The migrated one: a builder, nothing else.
    pixel = await repo("pixel-plays");
    expect(addToCrew(app, alice, pixel, "torque").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the page says nothing will act on a direction with no planner", async () => {
    const on = await updateRepoSettings(app, alice, pixel, {
      autonomy: "autonomous",
      autonomyDirection: "build more games!",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    expect(directionStall(app, fresh())).toContain("No planner is on the crew");
  });

  const stallOnPage = async () => {
    const res = await fetch(`${servers.url}/alice/pixel-plays/settings/autonomy`, { headers: { cookie } });
    return (await res.text()).includes('id="direction-stall"');
  };

  test("the card renders the stall for an admin, and the terminal's Vision lines carry it", async () => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(await stallOnPage()).toBe(true);
    const lines = visionLines(NO_VISION, 80, undefined, directionStall(app, fresh())!);
    expect(lines.map((l) => l.text).join(" ")).toContain("No planner is on the crew");
  });

  test("the next turn adds a planner and hands it the direction", async () => {
    expect(await driveRepo(app, fresh())).toBe("planned");
    const atlas = getUserByName(app.db, "atlas")!;
    expect(crewRole(app.db, pixel.id, atlas.id)).toBe("planner");
    const direction = getIssueById(app.db, fresh().directionIssueId!)!;
    expect(direction.assigneeId).toBe(atlas.id);
    expect(directionStall(app, fresh())).toBeNull();
    expect(await stallOnPage()).toBe(false);
    // Lent through addToCrew: the same event an admin's add emits.
    const added = app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM event WHERE kind = 'crew.added' AND repo_id = ?1 AND payload LIKE '%atlas%'",
      )
      .get(pixel.id)!;
    expect(added.n).toBe(1);
  });

  test("a planner with a crew but no direction issue yet reads the second message", async () => {
    const third = await repo("third");
    expect(addToCrew(app, alice, third, "atlas").ok).toBe(true);
    seatAs(app.db, third.id, getUserByName(app.db, "atlas")!.id, "planner");
    await updateRepoSettings(app, alice, third, {
      autonomy: "assisted",
      autonomyDirection: "more",
      autonomyBy: alice.id,
    });
    expect(directionStall(app, getRepoById(app.db, third.id)!)).toContain("has not opened the direction issue");
  });

  test("nothing is lent when the owner has no planner, or the actor may not add one", async () => {
    const bob = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    const made = await coreCreateRepo(app.db, app.reposRoot, { ownerId: bob.value.id, name: "bobs", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, bob.value, made.value, "torque").ok).toBe(true);
    // atlas plans only on alice's repositories: bob's private repository is not lent it.
    expect(ensurePlanner(app, made.value, bob.value)).toBeUndefined();
    // A candidate exists on alice's own repository, but bob may not add it there.
    const fourth = await repo("fourth");
    expect(ensurePlanner(app, fourth, bob.value)).toBeUndefined();
    expect(crewRole(app.db, fourth.id, getUserByName(app.db, "atlas")!.id)).toBeUndefined();
    // And alice, not an admin of bob's repository, cannot add it either way.
    expect(ensurePlanner(app, made.value, alice)).toBeUndefined();
    expect(await driveRepo(app, { ...made.value, autonomy: "autonomous", autonomyDirection: "go" })).not.toBe("planned");
    expect(directionStall(app, { ...made.value, autonomy: "autonomous", autonomyDirection: "go" })).toContain(
      "No planner is on the crew",
    );
    expect(crewRole(app.db, made.value.id, getUserByName(app.db, "atlas")!.id)).toBeUndefined();
  });
});
