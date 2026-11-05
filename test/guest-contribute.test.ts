/**
 * A guest helps build a public repository: a fork of their own that runs
 * nothing, a pull that waits for a person, and low limits, each refused in
 * plain words (`docs/ROLES.md`). The last test walks the whole way, from
 * sign-up to a person landing the change.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, deleteRepo, forkRepo } from "../src/actions/repos.ts";
import { enableApp } from "../src/actions/apps.ts";
import { makeItYours } from "../src/actions/make_it_yours.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { GUEST_REFUSALS, HELP_BUILD, HELP_BUILD_NEXT, isContributionFork, SIGNUP_YOU_GET } from "../src/core/contribute.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { canAdmin, canWrite, getRepoById, type Repo } from "../src/core/repos.ts";
import { NOT_A_MEMBER, setMember } from "../src/core/roles.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { markVerified } from "../src/core/verify.ts";
import { foldWall } from "../src/crew/fold_walls.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { sendToReview } from "../src/crew/review.ts";
import { getIssueById } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { isGuestPull, guestWaits } from "../src/origins/guest.ts";
import { setLimit } from "../src/settings/limits.ts";
import { setSignup } from "../src/settings/signup.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const LONG_AGO = "2026-01-01T00:00:00.000Z";

describe("a guest helps build a public repository", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let owner: User;
  let lib: Repo;
  let hidden: Repo;
  let n = 0;

  /** A verified guest whose cooldown has passed, with a token. */
  async function guest(fresh = false): Promise<{ user: User; token: string }> {
    const username = `guest${++n}`;
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@test.dev`, password: "correct-horse-battery" });
    if (!made.ok) throw new Error(made.error);
    markVerified(app.db, made.value.id, new Date().toISOString());
    if (!fresh) app.db.query("UPDATE user SET created_at = ?1 WHERE id = ?2").run(LONG_AGO, made.value.id);
    return {
      user: getUserByName(app.db, username)!,
      token: createToken(app.db, made.value.id, "t", "rw").token,
    };
  }

  const api = (token: string, path: string, method = "POST", body: unknown = {}) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });

  async function fork(user: User, parent: Repo = lib): Promise<Repo> {
    const made = await forkRepo(app, user, parent);
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  }

  async function publicRepo(name: string): Promise<Repo> {
    const made = await createRepo(app, owner, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, owner, made.value, { message: "Start", files: [{ path: "README.md", content: "hi\n" }] });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    return getRepoById(app.db, made.value.id)!;
  }

  /** A guest's pull from a new fork, changing `path`. */
  async function guestPull(user: User, path: string, parent: Repo = lib) {
    const head = await fork(user, parent);
    const committed = await commitToBranch(app, user, head, { branch: "change", message: "Change", files: [{ path, content: "x\n" }] });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const pull = await openPull(app, user, parent, { title: "A change", body: "", baseBranch: "main", headBranch: "change", headRepo: head });
    if (!pull.ok) throw new Error(String(pull.error));
    return { head, pull: pull.value };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-guest-contribute-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1 });
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "olive", email: "o@test.dev", password: "correct-horse-battery" });
    if (!made.ok) throw new Error(made.error);
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.id);
    markVerified(app.db, made.value.id, new Date().toISOString());
    owner = getUserByName(app.db, "olive")!;
    lib = await publicRepo("lib");
    const secret = await createRepo(app, owner, { name: "hidden", visibility: "private" });
    if (!secret.ok) throw new Error(String(secret.error));
    hidden = secret.value;
    setLimit(app.db, "signup.per_source", 1000, "setup");
    setLimit(app.db, "guest.forks_forge_per_day", 1000, "setup");
  }, 60_000);

  afterAll(async () => {
    checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a guest forks a public repository; the fork is public, marked, and theirs to write only", async () => {
    const { user, token } = await guest();
    const res = await api(token, "/api/v1/repos/olive/lib/forks");
    expect(res.status).toBe(201);
    const made = getRepoById(app.db, ((await res.json()) as { id: string }).id)!;
    expect(made.visibility).toBe("public");
    expect(isContributionFork(app.db, made.id)).toBe(true);
    expect(canWrite(app.db, made, user)).toBe(true);
    expect(canAdmin(app.db, made, user)).toBe(false);
    expect(canAdmin(app.db, made, owner)).toBe(true);
  });

  test("a private repository is refused, through the API and the page", async () => {
    const { user, token } = await guest();
    // Even one who can read it, as an organization's member might.
    const readable = await forkRepo(app, user, hidden);
    expect(readable.ok).toBe(false);
    app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(lib.id);
    expect((await forkRepo(app, user, getRepoById(app.db, lib.id)!)).ok).toBe(false);
    app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(lib.id);
    const res = await api(token, "/api/v1/repos/olive/hidden/forks");
    expect(res.status).toBe(404);
    const direct = await forkRepo(app, user, lib, undefined, { visibility: "private" });
    expect(direct.ok && direct.value.visibility).toBe("public");
  });

  test("a guest cannot fork a guest's fork", async () => {
    const a = await guest();
    const b = await guest();
    const first = await fork(a.user);
    const second = await forkRepo(app, b.user, first);
    expect(!second.ok && second.error).toBe("guest_copy");
  });

  test("each withheld action is refused through the API and MCP", async () => {
    const { user, token } = await guest();
    const mine = await fork(user);
    const base = `/api/v1/repos/${user.username}/${mine.name}`;
    const create = await api(token, "/api/v1/repos", "POST", { name: "fresh" });
    expect(create.status).toBe(403);
    expect(((await create.json()) as { message: string }).message).toBe(NOT_A_MEMBER);
    expect((await api(token, "/api/v1/apps", "POST", { name: "fresh2" })).status).toBe(403);
    expect((await api(token, "/api/v1/repos/olive/lib/make-it-yours", "POST", { dryRun: false })).status).toBeGreaterThanOrEqual(403);
    // An admin-scope token is the guest's own to mint; the fork still has no such doors.
    const full = createToken(app.db, user.id, "full", "admin").token;
    expect((await api(full, base, "PATCH", { visibility: "private" })).status).toBe(404);
    expect((await api(full, `${base}/hooks`, "POST", { url: "http://127.0.0.1:9/" })).status).toBe(404);
    expect((await api(full, `${base}/crew/anyone`, "PUT", {})).status).toBe(404);
    expect((await api(full, `${base}/app`, "POST", {})).status).toBe(404);
    expect((await mcpTool(servers.url, token, "new_app", { name: "fresh3" })).error).toBeDefined();
    expect((await mcpTool(servers.url, token, "make_it_yours", { repo: "olive/lib", dryRun: false })).error).toBeDefined();
    expect((await makeItYours(app, user, lib, { dryRun: false })).ok).toBe(false);
    expect(enableApp(app, user, mine).ok).toBe(false);
    expect(addToCrew(app, user, mine, "anyone").ok).toBe(false);
    expect((await createRepo(app, user, { name: "fresh4" })).ok).toBe(false);
    expect(getRepoById(app.db, mine.id)!.visibility).toBe("public");
  });

  test("a refusal on the page says what a guest can do instead", async () => {
    const { user } = await guest();
    const session = createSession(app.db, user.id).token;
    const cookie = { cookie: `forge_session=${session}` };
    const shelf = await publicRepo("an-app");
    const record = enableApp(app, owner, shelf);
    if (!record.ok) throw new Error(String(record.error));
    const copy = await (await fetch(`${servers.url}/olive/an-app/make-it-yours`, { headers: cookie })).text();
    expect(copy).toContain(HELP_BUILD);
    expect(copy).toContain(HELP_BUILD_NEXT.slice(0, 30));
    expect(copy).not.toContain("Make it yours");
    const home = await (await fetch(`${servers.url}/olive/lib`, { headers: cookie })).text();
    expect(home).toContain(HELP_BUILD);
    const posted = await fetch(`${servers.url}/olive/hidden/fork`, {
      method: "POST",
      redirect: "manual",
      headers: { ...cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(posted.status).toBe(404);
    expect(NOT_A_MEMBER).toContain("help build public apps");
  });

  test("a guest's fork runs nothing: no check, no deploy, no crew run", async () => {
    const { user } = await guest();
    const mine = await fork(user);
    const committed = await commitToBranch(app, user, mine, {
      message: "Try to run",
      files: [{ path: "forge.json", content: JSON.stringify({ check: "touch /tmp/ran" }) }, { path: "package.json", content: JSON.stringify({ scripts: { test: "touch /tmp/ran" } }) }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    expect(await checks.request(mine, "production", committed.value.commitOid, "push")).toBeUndefined();
    const runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", forgeUrl: "http://forge.test", concurrency: 1 } as never);
    expect((runtime as unknown as { mayRun: (r: unknown, repo: Repo, env: string, c: string) => boolean }).mayRun({ slug: "x" }, mine, "production", committed.value.commitOid)).toBe(false);
    const agent = await createAgent(app, owner, { username: `crew${++n}` });
    if (!agent.ok) throw new Error(String(agent.error));
    app.db.query("INSERT INTO repo_crew (repo_id, user_id, added_by) VALUES (?1, ?2, ?3)").run(mine.id, agent.value.user.id, owner.id);
    const issue = await api(createToken(app.db, user.id, "i", "rw").token, `/api/v1/repos/${user.username}/${mine.name}/issues`, "POST", { title: "Work" });
    const number = ((await issue.json()) as { number: number }).number;
    const row = app.db.query<{ id: string }, [string, number]>("SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2").get(mine.id, number)!;
    expect(queueAgentRun(app, mine, getIssueById(app.db, row.id)!, agent.value, "assigned")).toBeUndefined();
  });

  test("a guest may delete their own fork, and that makes no room in the day's count", async () => {
    const { user } = await guest();
    setLimit(app.db, "guest.forks_per_day", 1, "setup");
    const mine = await fork(user);
    expect((await deleteRepo(app, user, mine)).ok).toBe(true);
    const again = await forkRepo(app, user, lib);
    expect(!again.ok && again.error).toBe("guest_forks_today");
    setLimit(app.db, "guest.forks_per_day", 3, "setup");
  });

  test("the per-guest and whole-forge fork limits refuse in plain words", async () => {
    const { user, token } = await guest();
    setLimit(app.db, "guest.forks_per_day", 1, "setup");
    await fork(user);
    const other = await publicRepo("lib2");
    const res = await api(token, `/api/v1/repos/olive/${other.name}/forks`);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { message: string }).message).toBe(GUEST_REFUSALS.guest_forks_today);
    setLimit(app.db, "guest.forks_per_day", 3, "setup");
    const someone = await guest();
    setLimit(app.db, "guest.forks_forge_per_day", 0, "setup");
    const full = await forkRepo(app, someone.user, lib);
    expect(!full.ok && full.error).toBe("guest_forge_forks_today");
    setLimit(app.db, "guest.forks_forge_per_day", 1000, "setup");
  });

  test("a new account waits out its cooldown before a fork or a pull", async () => {
    const { user, token } = await guest(true);
    const res = await api(token, "/api/v1/repos/olive/lib/forks");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(GUEST_REFUSALS.guest_cooldown);
    const comment = await api(token, "/api/v1/repos/olive/lib/issues", "POST", { title: "A question" });
    expect(comment.status).toBe(201);
    expect(user.username).toBeTruthy();
  });

  test("an account with no confirmed email is told to confirm it", async () => {
    const made = await createUser(app.db, { origin: "seed", username: "unproven", email: "u@test.dev", password: "correct-horse-battery" });
    if (!made.ok) throw new Error(made.error);
    app.db.query("INSERT OR IGNORE INTO email_check (user_id) VALUES (?1)").run(made.value.id);
    app.db.query("UPDATE email_check SET verified_at = NULL WHERE user_id = ?1").run(made.value.id);
    const forked = await forkRepo(app, getUserByName(app.db, "unproven")!, lib);
    expect(!forked.ok && forked.error).toBe("unverified");
  });

  test("storage: a fork at its limit refuses a commit and a push, and a guest at theirs gets no new fork", async () => {
    const { user, token } = await guest();
    const mine = await fork(user);
    setLimit(app.db, "guest.fork_storage_mb", 1, "setup");
    const first = await commitToBranch(app, user, mine, { message: "Big", files: [{ path: "big.txt", content: Array.from({ length: 1_500_000 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join("") }] });
    expect(first.ok).toBe(true);
    const second = await commitToBranch(app, user, mine, { message: "More", files: [{ path: "more.txt", content: "y" }] });
    expect(!second.ok && second.error).toEqual({ kind: "storage_limit" });
    const put = await api(token, `/api/v1/repos/${user.username}/${mine.name}/contents`, "POST", { message: "m", branch: "main", files: [{ path: "a.txt", content: "a" }] });
    expect(put.status).toBe(413);
    const push = await fetch(`${servers.url}/${user.username}/${mine.name}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${user.username}:${token}`).toString("base64")}`, "content-type": "application/x-git-receive-pack-request" },
      body: "0000",
    });
    expect(await push.text()).toContain("storage limit reached");
    setLimit(app.db, "guest.fork_storage_mb", 50, "setup");
    setLimit(app.db, "guest.storage_mb", 1, "setup");
    const other = await publicRepo("lib3");
    const next = await forkRepo(app, user, other);
    expect(!next.ok && next.error).toBe("guest_storage");
    setLimit(app.db, "guest.storage_mb", 100, "setup");
    // Deleting makes the room back.
    expect((await deleteRepo(app, user, mine)).ok).toBe(true);
    setLimit(app.db, "guest.storage_mb", 1, "setup");
    expect((await forkRepo(app, user, other)).ok).toBe(true);
    setLimit(app.db, "guest.storage_mb", 100, "setup");
  });

  test("a guest sends pulls only from their own fork to its parent, and only so many a day", async () => {
    const { user, token } = await guest();
    const stranger = await guest();
    const theirs = await fork(stranger.user);
    const branchless = await openPull(app, user, lib, { title: "x", body: "", baseBranch: "main", headBranch: "main" });
    expect(!branchless.ok && branchless.error).toBe("guest_pull_shape");
    const fromAnother = await openPull(app, user, lib, { title: "x", body: "", baseBranch: "main", headBranch: "main", headRepo: theirs });
    expect(!fromAnother.ok && fromAnother.error).toBe("guest_pull_shape");
    const res = await api(token, "/api/v1/repos/olive/lib/pulls", "POST", { title: "x", base: "main", head: "main" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(GUEST_REFUSALS.guest_pull_shape);
    setLimit(app.db, "guest.pulls_per_day", 1, "setup");
    const { head } = await guestPull(user, "one.md");
    await commitToBranch(app, user, head, { branch: "second", base: "main", message: "Two", files: [{ path: "two.md", content: "2\n" }] });
    const over = await openPull(app, user, lib, { title: "Two", body: "", baseBranch: "main", headBranch: "second", headRepo: head });
    expect(!over.ok && over.error).toBe("guest_pulls_today");
    setLimit(app.db, "guest.pulls_per_day", 5, "setup");
    // A pull git refuses gives the place back.
    setLimit(app.db, "guest.pulls_per_day", 2, "setup");
    const failed = await openPull(app, user, lib, { title: "No such branch", body: "", baseBranch: "main", headBranch: "nothing", headRepo: head });
    expect(failed.ok).toBe(false);
    const fine = await openPull(app, user, lib, { title: "Two", body: "", baseBranch: "main", headBranch: "second", headRepo: head });
    expect(fine.ok).toBe(true);
    setLimit(app.db, "guest.pulls_per_day", 5, "setup");
  });

  test("a guest's pull waits for a person: no code runs, no crew, and a wall path is named", async () => {
    const { user } = await guest();
    const target = await publicRepo("autonomous-lib");
    app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?1 WHERE id = ?2").run(owner.id, target.id);
    const repo = getRepoById(app.db, target.id)!;
    const { pull } = await guestPull(user, "src/auth/login.ts", repo);
    expect(isGuestPull(app.db, pull)).toBe(true);
    expect(guestWaits(app.db, pull)).toBe(true);
    expect(pullMayRun(app.db, repo, pull, pull.headOid)).toBe(false);
    expect(await checks.request(repo, `pull-${pull.number}`, pull.headOid, "pull", pull.id)).toBeUndefined();
    expect(await sendToReview(app, repo, pull)).not.toBe("sent");
    expect(await landIfGreen(app, repo, pull)).toBe(false);
    const walls = await foldWall(app, repo, pull, repo.defaultBranch);
    expect(walls.join()).toContain("a guest's pull touches");
  });

  test("the fork's page sends a pull through the web, and a refusal there is in plain words", async () => {
    const { user } = await guest();
    const mine = await fork(user);
    await commitToBranch(app, user, mine, { branch: "web", message: "Web", files: [{ path: "web.md", content: "w\n" }] });
    const headers = {
      cookie: `forge_session=${createSession(app.db, user.id).token}`,
      origin: servers.url,
      "content-type": "application/x-www-form-urlencoded",
    };
    const page = await (await fetch(`${servers.url}/${user.username}/${mine.name}`, { headers })).text();
    expect(page).toContain("Send for review");
    expect(page).toContain("Delete this copy");
    setLimit(app.db, "guest.pulls_per_day", 0, "setup");
    const form = new URLSearchParams({ title: "From the web", body: "", base: "main", head: "web" });
    const refused = await fetch(`${servers.url}/${user.username}/${mine.name}/pulls/new`, { method: "POST", redirect: "manual", headers, body: form });
    expect(await refused.text()).toContain("pull requests. Come back tomorrow");
    setLimit(app.db, "guest.pulls_per_day", 5, "setup");
    const sent = await fetch(`${servers.url}/${user.username}/${mine.name}/pulls/new`, { method: "POST", redirect: "manual", headers, body: form });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toContain("/olive/lib/pulls/");
    const seen = await (await fetch(`${servers.url}${sent.headers.get("location")}`, { headers: { cookie: `forge_session=${createSession(app.db, owner.id).token}` } })).text();
    expect(seen).toContain("Approve this guest");
    const dropped = await fetch(`${servers.url}/${user.username}/${mine.name}/settings/delete`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: new URLSearchParams({ confirm: `${user.username}/${mine.name}` }),
    });
    expect(dropped.status).toBe(303);
    expect(getRepoById(app.db, mine.id)).toBeUndefined();
  });

  test("a member and an admin keep what they had; promotion lifts the guest's limits", async () => {
    const { user } = await guest();
    const mine = await fork(user);
    expect(canAdmin(app.db, mine, user)).toBe(false);
    setMember(app.db, user.id, true, owner.id, new Date());
    expect(isContributionFork(app.db, mine.id)).toBe(false);
    expect(canAdmin(app.db, mine, user)).toBe(true);
    expect(enableApp(app, getUserByName(app.db, user.username)!, mine).ok).toBe(true);
    const made = await createRepo(app, user, { name: "own-repo", visibility: "private" });
    expect(made.ok).toBe(true);
    const member = await guest();
    promote(app.db, member.user);
    const forked = await forkRepo(app, member.user, lib, undefined, { visibility: "private" });
    expect(forked.ok && forked.value.visibility).toBe("private");
    expect(forked.ok && isContributionFork(app.db, forked.value.id)).toBe(false);
    const adminFork = await forkRepo(app, owner, hidden, "hidden-copy");
    expect(adminFork.ok).toBe(true);
    const direct = await createRepo(app, owner, { name: "still-mine" });
    expect(direct.ok).toBe(true);
  });

  test("an agent still owns nothing", async () => {
    const agent = await createAgent(app, owner, { username: `bot${++n}` });
    if (!agent.ok) throw new Error(String(agent.error));
    const made = await createRepo(app, agent.value.user, { name: "agent-repo" });
    expect(!made.ok && made.error).toBe("forbidden_owner");
    const copied = await makeItYours(app, agent.value.user, lib, { dryRun: false });
    expect(copied.ok).toBe(false);
  });

  test("the account ceilings refuse per address and for the forge, and closed stops everything", async () => {
    const signup = (username: string, address = "198.51.100.7") =>
      fetch(`${servers.url}/api/v1/users`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-address": address },
        body: JSON.stringify({ username, email: `${username}@test.dev`, password: "correct-horse-battery" }),
      });
    setLimit(app.db, "signup.per_source", 1, "setup");
    setLimit(app.db, "signup.per_source_hour", 1, "setup");
    const first = await signup(`hour${++n}`);
    expect(first.status).toBe(201);
    const second = await signup(`hour${++n}`);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    setLimit(app.db, "signup.per_source_hour", 1000, "setup");
    setLimit(app.db, "signup.per_forge_hour", 1, "setup");
    expect((await signup(`hour${++n}`)).status).toBe(429);
    setLimit(app.db, "signup.per_forge_hour", 1000, "setup");
    setSignup(app.db, "closed", "setup");
    const closed = await signup(`closed${++n}`);
    expect(closed.status).toBe(403);
    expect(((await closed.json()) as { error: string }).error).toBe("signup_closed");
    const page = await fetch(`${servers.url}/signup`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: `closed${++n}`, password: "correct-horse-battery" }),
    });
    expect(page.status).not.toBe(303);
    setSignup(app.db, "open", "setup");
  });

  test("the sign-up page says what you get, and the security page counts today's accounts", async () => {
    const text = await (await fetch(`${servers.url}/signup`)).text();
    expect(text).toContain(SIGNUP_YOU_GET);
    expect(text).toContain("get your own forge");
    expect(text).toContain('href="/forges/new"');
    const session = createSession(app.db, owner.id).token;
    const security = await (await fetch(`${servers.url}/settings/security`, { headers: { cookie: `forge_session=${session}` } })).text();
    expect(security).toContain("new accounts today");
    expect(security).toContain('href="/settings/people"');
    expect(security).toContain("Close sign-up now");
  });

  test("the whole way: sign up, fork, commit, pull, and a person's review lands it", async () => {
    const username = `walker${++n}`;
    const signed = await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, email: `${username}@test.dev`, password: "correct-horse-battery" }),
    });
    expect(signed.status).toBe(201);
    const user = getUserByName(app.db, username)!;
    markVerified(app.db, user.id, new Date().toISOString());
    app.db.query("UPDATE user SET created_at = ?1 WHERE id = ?2").run(LONG_AGO, user.id);
    const token = createToken(app.db, user.id, "walk", "rw").token;
    const repo = await publicRepo("walk-lib");

    const forked = await api(token, `/api/v1/repos/olive/${repo.name}/forks`);
    expect(forked.status).toBe(201);
    const commit = await api(token, `/api/v1/repos/${username}/${repo.name}/contents`, "POST", { branch: "fix", message: "Fix", files: [{ path: "fix.md", content: "fixed\n" }] });
    expect(commit.status).toBe(201);
    const opened = await api(token, `/api/v1/repos/olive/${repo.name}/pulls`, "POST", { title: "Fix", base: "main", head: "fix", headRepo: `${username}/${repo.name}` });
    expect(opened.status).toBe(201);
    const number = ((await opened.json()) as { number: number }).number;

    const ownerToken = createToken(app.db, owner.id, "own", "rw").token;
    const approved = await api(ownerToken, `/api/v1/repos/olive/${repo.name}/pulls/${number}/review-states`, "POST", { state: "approved", body: "Thanks" });
    expect(approved.status).toBeLessThan(300);
    const merged = await api(ownerToken, `/api/v1/repos/olive/${repo.name}/pulls/${number}/merge`, "POST", { strategy: "squash" });
    expect(merged.status).toBeLessThan(300);
  });
});
