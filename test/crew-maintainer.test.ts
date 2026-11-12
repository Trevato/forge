/**
 * The maintainer role (#11203): an agent can be made one, the crew lists it by
 * the same word, and it has no path to merge, land or push the default
 * branch, and is never picked as builder, planner or reviewer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { landPastGate } from "../src/checks/bypass.ts";
import { crewWithRole, crewRole, getAgentByName, isCrewRole, listCrewRoles, type Agent } from "../src/core/agents.ts";
import { openIssue } from "../src/actions/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { outsideSeat } from "../src/crew/dispatch.ts";
import { pickBuilder } from "../src/crew/route.ts";
import { pickReviewer, reviewersOf } from "../src/crew/review.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { checkSeatSlots } from "../src/crew/seat_slots.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { aboutScreen, maintainerRows } from "../src/tui/screens/about.ts";
import { localSource } from "../src/view/local.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "Tidy",
  GIT_AUTHOR_EMAIL: "tidy@forge.local",
  GIT_COMMITTER_NAME: "Tidy",
  GIT_COMMITTER_EMAIL: "tidy@forge.local",
});

async function sh(args: string[], cwd: string) {
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err: err.trim() };
}

describe("a maintainer", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let tidy: Agent;
  let token: string;

  const mainTip = () => resolveOid(repoDir(app.reposRoot, "alice", "yard"), "refs/heads/main");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-maintainer-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", username: "alice", email: "alice@forge.local", password: "a-long-crew-passphrase", adminIfFirst: true, trusted: true });
    if (!made.ok) throw new Error("user");
    alice = made.value;
    const r = await createRepo(app, alice, { name: "yard", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    await commitToBranch(app, alice, r.value, { message: "seed", files: [{ path: "README.md", content: "# yard\n" }] });
    repo = getRepo(app.db, "alice", "yard")!;
    const a = await createAgent(app, alice, { username: "tidy", roles: ["maintainer"] });
    if (!a.ok) throw new Error(a.error);
    tidy = getAgentByName(app.db, "tidy")!;
    const added = addToCrew(app, alice, repo, "tidy", "maintainer");
    if (!added.ok) throw new Error(added.error);
    token = createToken(app.db, tidy.user.id, "t", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("is a crew role: an agent declares it and holds the seat, listed by the same word", () => {
    expect(isCrewRole("maintainer")).toBe(true);
    expect(tidy.roles).toEqual(["maintainer"]);
    expect(crewRole(app.db, repo.id, tidy.user.id)).toBe("maintainer");
    expect(listCrewRoles(app.db, repo.id).map((c) => [c.agent.user.username, c.role])).toEqual([["tidy", "maintainer"]]);
  });

  test("is named on the repository's team page", async () => {
    const signed = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-crew-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${servers.url}/alice/yard/settings`, { headers: { cookie } })).text();
    expect(page).toContain("Maintainers");
    expect(page).toContain('data-seat="maintainer"');
    expect(page).toContain('data-member="tidy"');
  });

  test("is not a pillar: it has no slots to set", () => {
    expect(checkSeatSlots("maintainer", 1)).toBeUndefined();
    expect(checkSeatSlots("builder", 1)).toEqual({ role: "builder", slots: 1 });
  });

  test("is refused merge, and land past the gate; main does not move", async () => {
    await commitToBranch(app, alice, repo, { branch: "tidying", message: "tidy", files: [{ path: "t.txt", content: "t\n" }] });
    const opened = await openPull(app, alice, repo, { title: "tidy", baseBranch: "main", headBranch: "tidying" });
    if (!opened.ok) throw new Error(String(opened.error));
    const before = await mainTip();
    const merged = await mergePull(app, tidy.user, repo, opened.value, "squash");
    expect(merged).toEqual({ ok: false, error: "forbidden" });
    const landed = await landPastGate(app, tidy.user, repo, opened.value, "tidying up the yard, past the gate");
    expect(landed.ok).toBe(false);
    expect(landed.ok ? "" : landed.error.kind).toBe("forbidden");
    expect(await mainTip()).toBe(before);
  });

  test("is refused a push to the default branch", async () => {
    const remote = `${servers.url.replace("://", `://tidy:${token}@`)}/alice/yard.git`;
    const clone = join(dir, "clone");
    expect((await sh(["git", "clone", "--quiet", remote, clone], dir)).code).toBe(0);
    await Bun.write(join(clone, "M.md"), "m\n");
    await sh(["git", "add", "M.md"], clone);
    await sh(["git", "commit", "-qm", "m"], clone);
    const before = await mainTip();
    const pushed = await sh(["git", "push", "-q", "origin", "HEAD:main"], clone);
    expect(pushed.code).not.toBe(0);
    expect(await mainTip()).toBe(before);
    // On its own fork it may push branches, and the hook still keeps its default branch.
    const forked = await forkRepo(app, tidy.user, repo);
    if (!forked.ok) throw new Error(String(forked.error));
    const fork = `${servers.url.replace("://", `://tidy:${token}@`)}/${forked.value.ownerName}/${forked.value.name}.git`;
    expect((await sh(["git", "push", "-q", fork, "HEAD:refs/heads/own-branch"], clone)).code).toBe(0);
    const refused = await sh(["git", "push", "-q", fork, `HEAD:${forked.value.defaultBranch}`], clone);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("agents propose through pulls");
  }, 30_000);

  test("is never picked as builder, planner or reviewer", async () => {
    const issue = await openIssue(app, alice, repo, { title: "work" });
    if (!issue.ok) throw new Error(issue.error);
    for (const reason of ["assigned", "feedback", "check_failed", "conflict", "resolve", "converge", "review"] as const)
      expect(outsideSeat(app, repo, issue.value, tidy, reason)).toBe(true);
    const as = { ...issue.value, kind: "pull" as const };
    for (const reason of ["feedback", "review"] as const) expect(outsideSeat(app, repo, as, tidy, reason)).toBe(true);
  });

  test("the pickers choose the builder and the reviewer, never the maintainer beside them", async () => {
    for (const [name, role] of [["maker", "builder"], ["looker", "reviewer"]] as const) {
      const made = await createAgent(app, alice, { username: name, roles: [role] });
      if (!made.ok) throw new Error(made.error);
      const added = addToCrew(app, alice, repo, name, role);
      if (!added.ok) throw new Error(added.error);
    }
    const issue = await openIssue(app, alice, repo, { title: "pick" });
    if (!issue.ok) throw new Error(issue.error);
    const builders = crewWithRole(app.db, [repo.id], "builder").get(repo.id) ?? [];
    expect(builders.map((b) => b.user.username)).toEqual(["maker"]);
    // Even an issue assigned to the maintainer goes to the builder.
    expect(pickBuilder(issue.value, builders, new Map())?.user.username).toBe("maker");
    expect(pickReviewer(reviewersOf(app.db, repo.id), [], [], new Map())?.user.username).toBe("looker");
    expect((crewWithRole(app.db, [repo.id], "planner").get(repo.id) ?? []).map((a) => a.user.username)).toEqual([]);
  });

  test("the team page's add form refuses an agent that does not declare maintainer", async () => {
    const made = await createAgent(app, alice, { username: "plainbuilder", roles: ["builder"] });
    if (!made.ok) throw new Error(made.error);
    const signed = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-crew-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await fetch(`${servers.url}/alice/yard/settings/crew`, {
      method: "POST",
      headers: { origin: servers.url, cookie },
      body: new URLSearchParams({ role: "maintainer", agent: "plainbuilder" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(listCrewRoles(app.db, repo.id).map((c) => c.agent.user.username)).not.toContain("plainbuilder");
    const direct = addToCrew(app, alice, repo, "plainbuilder", "maintainer");
    expect(direct).toEqual({ ok: false, error: "role_not_declared" });
    const spare = await createAgent(app, alice, { username: "spare", roles: ["maintainer"] });
    if (!spare.ok) throw new Error(spare.error);
    const again = await (await fetch(`${servers.url}/alice/yard/settings`, { headers: { cookie } })).text();
    const from = again.indexOf('id="f-add-maintainer"');
    expect(from).toBeGreaterThan(-1);
    const select = again.slice(from, again.indexOf("</select>", from));
    expect(select).toContain('value="spare"');
    expect(select).not.toContain('value="plainbuilder"');
  });

  test("the slots endpoints refuse maintainer: page, MCP and the check itself", async () => {
    expect(checkSeatSlots("maintainer", 0)).toBeUndefined();
    const signed = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-crew-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const before = getRepo(app.db, "alice", "yard")!;
    const res = await fetch(`${servers.url}/alice/yard/settings/pillars`, {
      method: "POST",
      headers: { origin: servers.url, cookie },
      body: new URLSearchParams({ seat: "maintainer", slots: "3" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(JSON.stringify(getRepo(app.db, "alice", "yard"))).toBe(JSON.stringify(before));
    const adminTok = createToken(app.db, alice.id, "admin", "admin").token;
    const over = await mcpTool(servers.url, adminTok, "crew", { repo: "alice/yard", seat: "maintainer", slots: 3, dryRun: false });
    expect(over.error ?? "").toContain("`seat` is planner, builder or reviewer");
  });

  test("the terminal's About screen shows the Maintainer seat, and m adds a maintainer", async () => {
    const made = await createAgent(app, alice, { username: "second", roles: ["maintainer"] });
    if (!made.ok) throw new Error(made.error);
    const pushed: string[] = [];
    const ctx = { invalidate() {}, toast: (m: string) => pushed.push(m), push() {}, pop() {}, copy() {} } as unknown as Ctx;
    const f = { app, db: app.db, user: alice } as unknown as Session;
    const at = () => getRepo(app.db, "alice", "yard")!;
    expect(maintainerRows(f, at())).toEqual([["Maintainer", "tidy"]]);
    const screen = aboutScreen(f, ctx, {} as Screen, localSource(app, at(), alice), undefined, "main");
    expect(screen.keys.some((b) => b.keys.includes("m"))).toBe(true);
    screen.key!({ key: "m" } as never);
    expect(crewRole(app.db, repo.id, getAgentByName(app.db, "second")!.user.id)).toBe("maintainer");
    expect(pushed[0]).toBe("second is a maintainer");
    expect(maintainerRows(f, at())[0]![1]).toContain("second");
  });
});
