/**
 * The team's three seats: `seatsOf` says who fills each and what an empty one
 * costs; the crew card draws it with one button per empty seat (an admin's);
 * `addToCrew` names the seat only for an agent who joins now; the terminal's
 * About card lists the seats and `p` fills one.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { crewRole, listCrewRoles, removeCrew } from "../src/core/agents.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { seatsOf } from "../src/crew/seats.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { aboutScreen, seatRows } from "../src/tui/screens/about.ts";
import type { Session } from "../src/tui/session.ts";
import { localSource } from "../src/view/local.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-crew-passphrase";

describe("the team's seats", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookies: Record<string, string> = {};

  const idOf = (name: string) => getUserByName(app.db, name)!.id;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const mode = (m: string) => app.db.query("UPDATE repo SET autonomy = ?1 WHERE id = ?2").run(m, repo.id);
  const states = (crewOff = false) =>
    Object.fromEntries(seatsOf(app.db, fresh(), crewOff).seats.map((s) => [s.role, s.state]));
  const page = async (who: string) => (await fetch(`${servers.url}/alice/yard/settings`, { headers: { cookie: cookies[who]! } })).text();
  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username, password: PASSWORD }), redirect: "manual" });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-seats-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const make = async (username: string) => {
      const r = await createUser(app.db, { origin: "seed", username, email: `${username}@forge.local`, password: PASSWORD, adminIfFirst: true, trusted: true });
      if (!r.ok) throw new Error("user");
      return r.value;
    };
    alice = await make("alice");
    await make("bob");
    const made = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "yard", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    for (const name of ["aplan", "bbuild"]) if (!(await createAgent(app, alice, { username: name, roles: ["planner", "builder", "reviewer"] })).ok) throw new Error("agent");
    cookies = { alice: await signIn("alice"), bob: await signIn("bob") };
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("auto mode off: every empty seat invites; auto mode on: it warns", () => {
    mode("off");
    expect(states()).toEqual({ planner: "invite", builder: "invite", reviewer: "invite" });
    expect(seatsOf(app.db, fresh()).auto).toBe(false);
    mode("autonomous");
    expect(states()).toEqual({ planner: "warn", builder: "warn", reviewer: "warn" });
    const reviewer = seatsOf(app.db, fresh()).seats[2]!;
    expect(reviewer.without).toBe("agent pulls wait for you");
  });

  test("a crew held off (a preview) invites even with auto mode on", () => {
    mode("autonomous");
    expect(states(true)).toEqual({ planner: "invite", builder: "invite", reviewer: "invite" });
    expect(seatsOf(app.db, fresh(), true).auto).toBe(false);
  });

  test("each list picks from the agents that declare its role, for an admin only", async () => {
    mode("autonomous");
    const html = await page("alice");
    for (const role of ["planner", "builder", "reviewer"]) {
      expect(html).toContain(`name="role" value="${role}"`);
      expect(html).toContain(`id="f-add-${role}"`);
    }
    expect(html).toContain('<option value="aplan">');
    expect(html).toContain("Planners");
    expect(await page("bob")).not.toContain('name="role"');
  });

  test("a filled seat names who fills it; the others still have a picker", async () => {
    expect(addToCrew(app, alice, fresh(), "aplan", "planner").ok).toBe(true);
    expect(states()).toEqual({ planner: "filled", builder: "warn", reviewer: "warn" });
    expect(seatsOf(app.db, fresh()).seats[0]!.by).toEqual(["aplan"]);
    const html = await page("alice");
    expect(html).toContain('data-member="aplan"');
    expect(html).toContain('id="f-add-builder"');
    expect(html).not.toContain("No planner:");
    expect(html).toContain("No builder: nothing gets built.");
  });

  test("an agent already on the crew keeps its role", () => {
    seatAs(app.db, repo.id, idOf("aplan"), "reviewer");
    const again = addToCrew(app, alice, fresh(), "aplan", "builder");
    expect(again.ok).toBe(true);
    expect(crewRole(app.db, repo.id, idOf("aplan"))).toBe("reviewer");
  });

  test("the terminal lists the seats and p fills the first empty one", () => {
    for (const c of listCrewRoles(app.db, repo.id)) removeCrew(app.db, repo.id, c.agent.user.id);
    mode("autonomous");
    const pushed: string[] = [];
    const ctx = { invalidate() {}, toast: (m: string) => pushed.push(m), push() {}, pop() {}, copy() {} } as unknown as Ctx;
    const f = { app, db: app.db, user: alice } as unknown as Session;
    const screen = aboutScreen(f, ctx, {} as Screen, localSource(app, fresh(), alice), undefined, "main");
    expect(seatRows(f, fresh()).map(([k]) => k)).toEqual(["Planner", "Builder", "Reviewer"]);
    expect(seatRows(f, fresh())[2]![1]).toContain("No reviewer: agent pulls wait for you.");
    expect(screen.keys.some((b) => b.keys.includes("p"))).toBe(true);
    screen.key!({ key: "p" } as never);
    expect(pushed[0]).toBe("aplan is on planner");
    expect(crewRole(app.db, repo.id, idOf("aplan"))).toBe("planner");
    expect(seatRows(f, fresh())[0]![1]).toBe("aplan");
    const bob = { app, db: app.db, user: { id: "x", isAdmin: false } } as unknown as Session;
    const other = aboutScreen(bob, ctx, {} as Screen, localSource(app, fresh(), undefined), undefined, "main");
    expect(other.keys.some((b) => b.keys.includes("p"))).toBe(false);
  });
});
