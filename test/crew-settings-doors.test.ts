/**
 * Settings › Crew: only the repository's admin changes its crew. The four
 * forms (add, role, subscriptions, remove) land back on `#crew` with a
 * flash for the admin; a signed-in non-admin and a guest get the not-found
 * page and nothing moves; a person or an unknown name is refused in words.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { crewRole, isCrew } from "../src/core/agents.ts";
import {
  addSubscription,
  listGrants,
  setGrants,
} from "../src/core/subscriptions.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo as initRepo, type Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-crew-passphrase";

describe("settings › crew doors", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let botId = "";
  let otherId = "";
  let carolRepo: Repo;
  let carol = "";
  let subId = "";
  let admin = "";
  let bob = "";

  const post = (
    path: string,
    body: Record<string, string>,
    cookie?: string,
  ): Promise<Response> =>
    fetch(`${servers.url}/alice/yard/settings/crew${path}`, {
      method: "POST",
      headers: { origin: servers.url, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  const flash = (res: Response): string =>
    decodeURIComponent(
      `${res.headers.get("location") ?? ""} ${res.headers.get("set-cookie") ?? ""}`.replace(
        /\+/g,
        " ",
      ),
    );

  const grants = () => listGrants(app.db, repo.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-settings-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
      trusted: true,
    });
    const b = await createUser(app.db, {
      origin: "seed",
      username: "bob",
      email: "bob@forge.local",
      password: PASSWORD,
      trusted: true,
    });
    if (!a.ok || !b.ok) throw new Error("users");
    const made = await createRepo(app, a.value, {
      name: "yard",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const bot = await createAgent(app, a.value, { username: "yardbot", roles: ["planner", "builder", "reviewer"] });
    if (!bot.ok) throw new Error("agent");
    botId = bot.value.user.id;
    const sub = addSubscription(app.db, dataDir, {
      name: "pool",
      token: "sk-ant-oat01-test-token-value",
    });
    if (!sub.ok) throw new Error("subscription");
    subId = sub.value.id;
    const other = await createAgent(app, a.value, { username: "otherbot", roles: ["planner", "builder", "reviewer"] });
    if (!other.ok) throw new Error("agent");
    otherId = other.value.user.id;
    const c = await createUser(app.db, {
      origin: "seed",
      username: "carol",
      email: "carol@forge.local",
      password: PASSWORD,
      trusted: true,
    });
    if (!c.ok) throw new Error("user");
    const cr = await initRepo(app.db, app.reposRoot, {
      ownerId: c.value.id,
      name: "carolyard",
      visibility: "public",
    });
    if (!cr.ok) throw new Error(String(cr.error));
    carolRepo = cr.value;
    carol = await signIn("carol");
    admin = await signIn("alice");
    bob = await signIn("bob");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a non-admin and a guest get not-found and the crew stays as it was", async () => {
    // Set up a crew member with a role and a grant to watch.
    const added = await post("", { agent: "yardbot" }, admin);
    expect(added.status).toBe(303);
    await post("/yardbot/role", { role: "reviewer" }, admin);
    setGrants(app.db, repo.id, botId, [subId]);
    const before = JSON.stringify(grants());

    for (const cookie of [bob, undefined]) {
      for (const [path, body] of [
        ["", { agent: "otherbot" }],
        ["/yardbot/role", { role: "planner" }],
        ["/yardbot/remove", {}],
        ["/subscriptions", {}],
      ] as const) {
        const res = await post(path, { ...body }, cookie);
        expect(res.status).toBe(404);
        expect(isCrew(app.db, repo.id, otherId)).toBe(false);
        expect(isCrew(app.db, repo.id, botId)).toBe(true);
        expect(crewRole(app.db, repo.id, botId)).toBe("reviewer");
        expect(JSON.stringify(grants())).toBe(before);
      }
    }
    // Clean up for the admin's walk.
    expect((await post("/yardbot/remove", {}, admin)).status).toBe(303);
    setGrants(app.db, repo.id, botId, []);
  });

  test("the admin adds, re-roles, saves subscriptions and removes, each back on #crew", async () => {
    const add = await post("", { agent: "yardbot" }, admin);
    expect(add.status).toBe(303);
    expect(add.headers.get("location")).toContain("/alice/yard/settings#crew");
    expect(flash(add)).toContain("yardbot is on the crew");
    expect(isCrew(app.db, repo.id, botId)).toBe(true);

    const role = await post("/yardbot/role", { role: "planner" }, admin);
    expect(role.headers.get("location")).toContain("#crew");
    expect(flash(role)).toContain("yardbot is a planner here");
    expect(crewRole(app.db, repo.id, botId)).toBe("planner");

    const bad = await post("/yardbot/role", { role: "emperor" }, admin);
    expect(flash(bad)).toContain("That role could not be set");
    expect(crewRole(app.db, repo.id, botId)).toBe("planner");

    const save = await post(
      "/subscriptions",
      { grant: `${botId}:${subId}` },
      admin,
    );
    expect(save.status).toBe(303);
    expect(save.headers.get("location")).toContain("#crew");
    expect(flash(save)).toContain("Saved");
    expect(grants().map((g) => [g.agentId, g.subscriptionId])).toEqual([
      [botId, subId],
    ]);

    const gone = await post("/yardbot/remove", {}, admin);
    expect(gone.headers.get("location")).toContain("#crew");
    expect(flash(gone)).toContain("yardbot is off the crew");
    expect(isCrew(app.db, repo.id, botId)).toBe(false);
  });

  test("a person or an unknown name is refused with a sentence, nothing written", async () => {
    const person = await post("", { agent: "bob" }, admin);
    expect(person.status).toBe(303);
    expect(flash(person)).toContain("Only an agent can be on a crew");
    const nobody = await post("", { agent: "ghost" }, admin);
    expect(flash(nobody)).toContain("No such agent on this forge");
    const rows = app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM repo_crew WHERE repo_id = ?1",
      )
      .get(repo.id)!;
    expect(rows.n).toBe(0);
  });

  test("a repository admin who is not a forge admin cannot save subscriptions", async () => {
    const own = (path: string, body: Record<string, string>) =>
      fetch(`${servers.url}/carol/carolyard/settings/crew${path}`, {
        method: "POST",
        headers: { origin: servers.url, cookie: carol },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    // She does administer her own repository: the add form answers her.
    expect((await own("", { agent: "otherbot" })).status).toBe(303);
    expect(isCrew(app.db, carolRepo.id, otherId)).toBe(true);
    setGrants(app.db, carolRepo.id, otherId, []);

    const res = await own("/subscriptions", {
      grant: `${otherId}:${subId}`,
    });
    expect(res.status).toBe(404);
    expect(listGrants(app.db, carolRepo.id)).toEqual([]);
  });

  test("the team card's button adds the agent in the pillar it names", async () => {
    const own = (body: Record<string, string>) =>
      fetch(`${servers.url}/carol/carolyard/settings/crew`, {
        method: "POST",
        headers: { origin: servers.url, cookie: carol },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    await fetch(`${servers.url}/carol/carolyard/settings/crew/otherbot/remove`, {
      method: "POST",
      headers: { origin: servers.url, cookie: carol },
      redirect: "manual",
    });
    expect((await own({ agent: "otherbot", role: "planner" })).status).toBe(303);
    expect(crewRole(app.db, carolRepo.id, otherId)).toBe("planner");
  });
});
