/**
 * An agent's roles are its own config (#8907): a repository narrows them and
 * never widens them, a dispatch never hands over a job outside them, and
 * /migrate offers builders only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, askedRoles, createAgent, updateAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { crewRole, getAgentByName, type Agent } from "../src/core/agents.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { outsideSeat } from "../src/crew/dispatch.ts";
import { migrationBuilders, prefill } from "../src/web/pages/migrate-prefill.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let app: App;
let admin: User;
let repo: Repo;

const agent = (name: string): Agent => getAgentByName(app.db, name)!;

beforeAll(async () => {
  app = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-roles-")), port: 0 });
  const made = await createUser(app.db, { origin: "seed", username: "alice", email: "alice@forge.local", password: "a-long-crew-passphrase", adminIfFirst: true, trusted: true });
  if (!made.ok) throw new Error("user");
  admin = made.value;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: admin.id, name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  const make = async (username: string, roles?: string[]) => {
    const a = await createAgent(app, admin, { username, ...(roles ? { roles } : {}) });
    if (!a.ok) throw new Error(`${username}: ${a.error}`);
  };
  await make("atlas", ["planner"]);
  await make("both", ["planner", "builder"]);
  await make("mason", ["builder"]);
  await make("rev", ["reviewer"]);
  await make("plain");
});
afterAll(() => app.db.close());

describe("roles are the agent's config", () => {
  test("an agent says its roles; none given reads as builder, bad ones are refused", () => {
    expect(agent("atlas").roles).toEqual(["planner"]);
    expect(agent("both").roles).toEqual(["planner", "builder"]);
    expect(agent("plain").roles).toEqual(["builder"]);
    const bad = updateAgent(app, admin, "mason", { roles: ["boss"] });
    expect(bad.ok ? "" : bad.error).toBe("invalid_roles");
    const empty = updateAgent(app, admin, "mason", { roles: [] });
    expect(empty.ok ? "" : empty.error).toBe("invalid_roles");
    expect(agent("mason").roles).toEqual(["builder"]);
  });

  test("a repository can narrow a role, never widen it", () => {
    const widened = addToCrew(app, admin, repo, "atlas", "builder");
    expect(widened.ok ? "" : widened.error).toBe("role_not_declared");
    expect(crewRole(app.db, repo.id, agent("atlas").user.id)).toBeUndefined();
    expect(addToCrew(app, admin, repo, "both", "builder").ok).toBe(true);
    expect(crewRole(app.db, repo.id, agent("both").user.id)).toBe("builder");
  });

  test("no role named: the first the agent declares, never builder by default", () => {
    expect(addToCrew(app, admin, repo, "rev").ok).toBe(true);
    expect(crewRole(app.db, repo.id, agent("rev").user.id)).toBe("reviewer");
  });

  test("taking a role an agent still holds on a repository is refused, not moved silently", () => {
    const held = updateAgent(app, admin, "both", { roles: ["planner"] });
    expect(held.ok ? "" : held.error).toBe("role_held");
    expect(agent("both").roles).toEqual(["planner", "builder"]);
    expect(crewRole(app.db, repo.id, agent("both").user.id)).toBe("builder");
    expect(updateAgent(app, admin, "both", { roles: ["builder", "reviewer"] }).ok).toBe(true);
    updateAgent(app, admin, "both", { roles: ["planner", "builder"] });
  });

  test("roles that are not a list of strings are invalid_roles, not ignored", () => {
    for (const bad of ["planner", 3, null, { a: 1 }, [1], [["planner"]]]) {
      const r = updateAgent(app, admin, "mason", { ...askedRoles(bad) });
      expect(r.ok ? "" : r.error).toBe("invalid_roles");
    }
    expect(askedRoles(undefined)).toEqual({});
    expect(agent("mason").roles).toEqual(["builder"]);
  });
});

describe("a dispatch never hands over a job outside the seat", () => {
  let issue: Awaited<ReturnType<typeof openIssue>> & { ok: true };
  beforeAll(async () => {
    const i = await openIssue(app, admin, repo, { title: "work" });
    if (!i.ok) throw new Error(i.error);
    issue = i as typeof issue;
    addToCrew(app, admin, repo, "mason", "builder");
  });

  test("planner seat: a build is refused", () => {
    app.db.query("UPDATE repo_crew SET role = 'planner' WHERE user_id = ?1").run(agent("both").user.id);
    expect(outsideSeat(app, repo, issue.value, agent("both"), "assigned")).toBe(true);
  });
  test("builder seat: a build is allowed, a review is not", () => {
    expect(outsideSeat(app, repo, issue.value, agent("mason"), "assigned")).toBe(false);
    expect(outsideSeat(app, repo, issue.value, agent("mason"), "review")).toBe(true);
  });
  test("reviewer seat: a review is allowed, a build is not", () => {
    expect(outsideSeat(app, repo, issue.value, agent("rev"), "review")).toBe(false);
    expect(outsideSeat(app, repo, issue.value, agent("rev"), "assigned")).toBe(true);
  });
});

describe("every kind of run keeps to the seat", () => {
  const reasons = ["assigned", "feedback", "check_failed", "conflict", "resolve", "converge"] as const;
  test("a non-builder is outside every building reason; a builder is outside a review", async () => {
    const i = await openIssue(app, admin, repo, { title: "more work" });
    if (!i.ok) throw new Error(i.error);
    app.db.query("UPDATE repo_crew SET role = 'planner' WHERE user_id = ?1").run(agent("both").user.id);
    for (const reason of reasons) {
      expect(outsideSeat(app, repo, i.value, agent("both"), reason)).toBe(true);
      expect(outsideSeat(app, repo, i.value, agent("rev"), reason)).toBe(true);
      expect(outsideSeat(app, repo, i.value, agent("mason"), reason)).toBe(false);
    }
    expect(outsideSeat(app, repo, i.value, agent("mason"), "review")).toBe(true);
  });
});

describe("/migrate offers builders only", () => {
  test("a planner that sorts first is never the default; crew= naming it is refused in a sentence", () => {
    const all = ["atlas", "both", "mason", "rev", "plain"].map(agent);
    const builders = migrationBuilders(all).map((a) => a.user.username);
    expect(builders).not.toContain("atlas");
    expect(builders).not.toContain("rev");
    expect(builders[0]).toBe("mason");
    const linked = prefill({ crew: "atlas" }, [], builders, ["atlas", "rev"]);
    expect(linked.agent).toBeUndefined();
    expect(linked.refused[0]).toContain("atlas is not a builder");
  });
});
