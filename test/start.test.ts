/**
 * An agent with only the forge's URL starts building in one call (#10912):
 * the start call, a push that deploys, the limits, the claim, and the
 * sleep/archive of what nobody claims. Against a scratch forge with its apps
 * runtime, so the app really comes up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claimStart } from "../src/actions/claim.ts";
import { startBuilding, PER_SOURCE_PER_HOUR } from "../src/actions/start.ts";
import { sweepStarts } from "../src/actions/start_sweep.ts";
import { getRepo, listReposOwnedBy } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { heldManifest, isUnclaimed, SMALL_APP } from "../src/core/starts.ts";
import { mintInvite } from "../src/core/invites.ts";
import { setAgentStart } from "../src/settings/agent_start.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { deploySettled, fetchAsHost, startAppsForge, stopAppsForge, type AppsForge } from "./helpers/apps-forge.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Muse",
  GIT_AUTHOR_EMAIL: "muse@f.dev",
  GIT_COMMITTER_NAME: "Muse",
  GIT_COMMITTER_EMAIL: "muse@f.dev",
});

let forge: AppsForge;
beforeAll(async () => {
  forge = await startAppsForge();
}, 60_000);
afterAll(async () => {
  await forge.runtime.stop();
  await stopAppsForge(forge);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}, ip = "198.51.100.1") =>
  fetch(`${forge.servers.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });

async function git(args: string[], cwd: string): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  return { code: await p.exited, err };
}

interface StartAnswer {
  user: { username: string };
  token: string;
  repo: string;
  git: { url: string; push: string };
  app: { url: string | null };
  claim: { url: string };
}

describe("start, push, live, claim", () => {
  let started: StartAnswer;

  test("one call with nothing but the URL makes the account, the repo, the app and a token", async () => {
    const res = await post("/api/v1/start", { name: "Glint Notes", description: "a notes app", agent: "glint" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    started = (await res.json()) as StartAnswer;
    expect(started.token).toStartWith("forge_");
    expect(started.repo).toMatch(/^glint-notes-[0-9a-f]+\/glint-notes$/);
    expect(started.claim.url).toContain("/claim/start/claim_");
    const repo = getRepo(forge.app.db, started.user.username, "glint-notes")!;
    expect(repo.visibility).toBe("public");
    // No crew, no password; held as a guest and unclaimed.
    expect(forge.app.db.query("SELECT COUNT(*) AS n FROM repo_crew WHERE repo_id = ?1").get(repo.id)).toEqual({ n: 0 });
    const user = getUserByName(forge.app.db, started.user.username)!;
    expect(user.kind).toBe("user");
    expect(isUnclaimed(forge.app.db, user.id)).toBe(true);
    expect(forge.app.db.query("SELECT password_hash FROM user WHERE id = ?1").get(user.id)).toEqual({ password_hash: "" });
  });

  test("the token is scoped to that account: it reads its own account and nobody else's private repo", async () => {
    const me = await fetch(`${forge.servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${started.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { username: string }).username).toBe(started.user.username);
    const admin = await fetch(`${forge.servers.url}/api/v1/admin/limits`, { headers: { authorization: `Bearer ${started.token}` } });
    expect([403, 404]).toContain(admin.status);
  });

  test("the app is live, and a push to main deploys the new commit", async () => {
    const repo = getRepo(forge.app.db, started.user.username, "glint-notes")!;
    const first = await deploySettled(forge.app, repo.id, (r) => r.env === "production");
    expect(first.state).toBe("ok");
    const slug = forge.runtime.hostFor("glint-notes", "production");
    expect((await fetchAsHost(forge.servers, slug)).status).toBe(200);

    const remote = started.git.url.replace("://", `://${started.user.username}:${started.token}@`);
    const dir = join(forge.work, "clone");
    expect((await git(["clone", "-q", remote, dir], forge.work)).code).toBe(0);
    await Bun.write(join(dir, "NOTES.md"), "pushed by an agent\n");
    await git(["-C", dir, "add", "."], forge.work);
    await git(["-C", dir, "commit", "-q", "-m", "an agent's change"], forge.work);
    const pushed = await git(["-C", dir, "push", "-q", "origin", "HEAD:main"], forge.work);
    expect(pushed.err).toBe("");
    expect(pushed.code).toBe(0);
    const head = (await Bun.spawn(["git", "-C", dir, "rev-parse", "HEAD"], { env: gitEnv, stdout: "pipe" }).stdout.text()).trim();
    const deadline = Date.now() + 60_000;
    let second = listRuns(forge.app.db, repo.id, { kind: "deploy", limit: 20 }).find((r) => r.commitOid === head && r.env === "production");
    while (second === undefined && Date.now() < deadline) {
      await Bun.sleep(25);
      second = listRuns(forge.app.db, repo.id, { kind: "deploy", limit: 20 }).find((r) => r.commitOid === head && r.env === "production");
    }
    expect(second).toBeDefined();
  }, 120_000);

  test("a person opens the claim link, makes an account, and the repo and the agent are theirs", async () => {
    const page = await fetch(started.claim.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("glint");
    const made = await fetch(`${started.claim.url}/account`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ username: "friend", email: "", password: "a-friendly-passphrase" }),
    });
    expect(made.status).toBe(303);
    expect(made.headers.get("set-cookie")).toContain("HttpOnly");
    const org = `${started.user.username}-team`;
    expect(made.headers.get("location")).toBe(`/${org}`);
    const moved = getRepo(forge.app.db, org, "glint-notes")!;
    expect(moved).toBeDefined();
    expect(isUnclaimed(forge.app.db, getUserByName(forge.app.db, started.user.username)!.id)).toBe(false);
    // The agent is a member with write: its token still pushes.
    const remote = started.git.url.replace(`/${started.user.username}/`, `/${org}/`).replace("://", `://${started.user.username}:${started.token}@`);
    const dir = join(forge.work, "clone2");
    expect((await git(["clone", "-q", remote, dir], forge.work)).code).toBe(0);
    await Bun.write(join(dir, "MORE.md"), "still writing\n");
    await git(["-C", dir, "add", "."], forge.work);
    await git(["-C", dir, "commit", "-q", "-m", "again"], forge.work);
    expect((await git(["-C", dir, "push", "-q", "origin", "HEAD:main"], forge.work)).code).toBe(0);
    // The link is burnt.
    const again = await claimStart(forge.app, getUserByName(forge.app.db, "friend"), started.claim.url.split("/").pop()!);
    expect(again).toEqual({ ok: false, error: "claimed" });
  }, 120_000);
});

describe("the defenses", () => {
  test("a bad body is refused at the boundary, and a page on another site cannot call it", async () => {
    expect((await post("/api/v1/start", {}, {}, "198.51.100.20")).status).toBe(422);
    expect((await post("/api/v1/start", { name: "x".repeat(41) }, {}, "198.51.100.20")).status).toBe(422);
    expect((await post("/api/v1/start", { name: "ok", agent: "bad name!" }, {}, "198.51.100.20")).status).toBe(422);
    expect((await post("/api/v1/start", { name: "ok", description: 5 }, {}, "198.51.100.20")).status).toBe(422);
    const cross = await post("/api/v1/start", { name: "ok" }, { origin: "https://evil.example" }, "198.51.100.20");
    expect(cross.status).toBe(403);
  });

  test("a few starts an hour from one source, then a wait; another source is not held", async () => {
    for (let i = 0; i < PER_SOURCE_PER_HOUR; i++)
      expect((await post("/api/v1/start", { name: `lim-${i}` }, {}, "198.51.100.30")).status).toBe(201);
    const held = await post("/api/v1/start", { name: "lim-x" }, {}, "198.51.100.30");
    expect(held.status).toBe(429);
    expect(held.headers.get("retry-after")).toBe("3600");
    expect((await post("/api/v1/start", { name: "lim-y" }, {}, "198.51.100.31")).status).toBe(201);
  }, 60_000);

  test("the setting: off refuses, a code asks for an open invite and spends it", async () => {
    const admin = forge.alice;
    setAgentStart(forge.app.db, "off", admin.id);
    const off = await post("/api/v1/start", { name: "nope" }, {}, "198.51.100.40");
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: string }).error).toBe("off");
    setAgentStart(forge.app.db, "code", admin.id);
    expect((await post("/api/v1/start", { name: "nope" }, {}, "198.51.100.40")).status).toBe(403);
    expect((await post("/api/v1/start", { name: "nope", code: "wrong" }, {}, "198.51.100.40")).status).toBe(403);
    const invite = mintInvite(forge.app.db, admin.id, 7);
    const ok = await post("/api/v1/start", { name: "coded", code: invite.token }, {}, "198.51.100.40");
    expect(ok.status).toBe(201);
    expect((await post("/api/v1/start", { name: "coded2", code: invite.token }, {}, "198.51.100.41")).status).toBe(403);
    setAgentStart(forge.app.db, "open", admin.id);
  }, 60_000);

  test("the MCP `start` tool answers with no token, as the API does", async () => {
    const res = await fetch(`${forge.servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-forwarded-for": "198.51.100.50" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start", arguments: { name: "via-mcp" } } }),
    });
    const body = (await res.json()) as any;
    const out = JSON.parse(body.result.content[0].text) as StartAnswer;
    expect(out.token).toStartWith("forge_");
  });

  test("an unclaimed account's app runs small with no host but the registries; a claimed one is not touched", async () => {
    const made = await startBuilding(forge.app, { name: "held" }, "198.51.100.60", "http://x");
    if (!made.ok) throw new Error(made.error.error);
    const owner = getUserByName(forge.app.db, made.value.user.username)!;
    const declared: { egress: string[]; limits: { memoryMiB: number; cpus: number; diskMiB?: number } } = { egress: ["api.example.com"], limits: { memoryMiB: 4096, cpus: 8 } };
    const held = heldManifest(forge.app.db, owner.id, declared);
    expect(held.egress).toEqual([]);
    expect(held.limits).toEqual({ memoryMiB: SMALL_APP.memoryMiB, cpus: SMALL_APP.cpus, diskMiB: SMALL_APP.diskMiB });
    expect(heldManifest(forge.app.db, forge.alice.id, declared)).toBe(declared);
  });

  test("asleep after 7 days (token dead), archived after 30 (not deleted); a claim wakes it", async () => {
    const made = await startBuilding(forge.app, { name: "idle" }, "198.51.100.70", "http://x");
    if (!made.ok) throw new Error(made.error.error);
    const owner = getUserByName(forge.app.db, made.value.user.username)!;
    const day = 86_400_000;
    expect(sweepStarts(forge.app, new Date(Date.now() + 6 * day)).slept).toBe(0);
    const slept = sweepStarts(forge.app, new Date(Date.now() + 8 * day));
    expect(slept.slept).toBeGreaterThan(0);
    const gone = await fetch(`${forge.servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${made.value.token}` } });
    expect(gone.status).toBe(401);
    sweepStarts(forge.app, new Date(Date.now() + 31 * day));
    const repos = listReposOwnedBy(forge.app.db, owner.id);
    expect(repos.length).toBe(1);
    expect(repos[0]!.archivedAt).not.toBeNull();
    const friend = getUserByName(forge.app.db, "friend")!;
    const taken = await claimStart(forge.app, friend, made.value.claim.url.split("/").pop()!);
    expect(taken.ok).toBe(true);
    const moved = getRepo(forge.app.db, `${owner.username}-team`, "idle")!;
    expect(moved.archivedAt).toBeNull();
  });
});
