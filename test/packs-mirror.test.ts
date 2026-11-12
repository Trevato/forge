/**
 * The packs' upstreams as read-only mirrors (#10530): brought in once by an
 * admin as `packs/<app>`, re-synced by the scheduled follow, pushed to by no
 * one. The upstream is a real bare repository served over dumb http.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { checkDue, FOLLOW_EVERY_MS } from "../src/actions/upstream_follow.ts";
import { listFollowing } from "../src/core/upstream_follow.ts";
import { createSession } from "../src/core/sessions.ts";
import { canWrite, createRepo, getRepo, listEveryRepo } from "../src/core/repos.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { SshSession } from "../src/ssh/channels.ts";
import { serveGitCommand } from "../src/tui/ssh.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { mirrorPacksScreen } from "../src/tui/screens/mirrorpacks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedPacks } from "./helpers/packs.ts";
import { settleApp } from "./helpers/tui.ts";
import { tool } from "../src/http/mcp/tools/repo_settings.ts";
import { mirrorPacks, packSources, reportWords } from "../src/packs/mirror.ts";
import { MIRROR_PUSH_REFUSED } from "../src/packs/owner.ts";
import { adminCookie, seedAdmin } from "./helpers/admin.ts";
import { mirrorOutbound } from "./helpers/globals.ts";

const ident = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

let dataDir = "";
let app: App;
let servers: Servers;
let admin: User;
let upstream: ReturnType<typeof Bun.serve>;
let bare = "";
let work = "";

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await runGit(args, { cwd, env: ident });
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${JSON.stringify(r)}`);
  return r.value.trim();
};

/** A commit on the upstream, published for dumb http. */
async function commit(text: string): Promise<string> {
  await Bun.write(join(work, "f.txt"), text);
  await git(work, "add", "f.txt");
  await git(work, "commit", "-m", text);
  await git(work, "push", "origin", "HEAD:refs/heads/trunk");
  await git(bare, "update-server-info");
  return git(work, "rev-parse", "HEAD");
}

mirrorOutbound({ allow: ["127.0.0.1"] });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-packs-mirror-"));
  bare = join(dataDir, "up.git");
  work = join(dataDir, "work");
  await git(dataDir, "init", "--bare", "-b", "trunk", bare);
  await git(dataDir, "clone", bare, work);
  await git(work, "checkout", "-b", "trunk");
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const rel = new URL(req.url).pathname.replace(/^\/up\.git\//, "");
      if (rel.includes("..")) return new Response("no", { status: 404 });
      const file = Bun.file(join(bare, rel));
      return (await file.exists()) ? new Response(file) : new Response("no", { status: 404 });
    },
  });
  app = createApp({ dataDir: join(dataDir, "data"), port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, { username: "boss", email: "boss@f.dev", password: "mirror-password" });
  if (!made.ok) throw new Error(made.error);
  admin = made.value;
});

afterAll(async () => {
  upstream?.stop(true);
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

function sshSession(command: string) {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | undefined;
  const text = (d: string | Uint8Array) => (typeof d === "string" ? d : new TextDecoder().decode(d));
  const session = {
    command,
    username: "git",
    env: {},
    remoteAddress: "127.0.0.1",
    write: (d: string | Uint8Array) => void out.push(text(d)),
    writeStderr: (d: string | Uint8Array) => void err.push(text(d)),
    exit: (c: number) => void (code = c),
    onData: (cb: (d: Uint8Array) => void) => setTimeout(() => cb(new TextEncoder().encode("0000")), 50),
    onEof: (cb: () => void) => setTimeout(cb, 100),
    onClose: () => {},
    drain: async () => {},
  } as unknown as SshSession;
  return { session, out, err, code: () => code };
}

describe("packs mirrors", () => {
  const source = () => [
    { name: "demo", source: `http://127.0.0.1:${upstream.port}/up.git`, description: "A demo." },
  ];
  let first = "";

  test("the packs' own https sources are what it would bring in", async () => {
    const other = createApp({ dataDir: join(dataDir, "catalog"), port: 0 });
    try {
      await seedPacks(other);
    } finally {
      other.close();
    }
    const names = packSources().map((s) => s.name);
    expect(names).toContain("hextris");
    expect(names).toContain("2048");
    expect(packSources().every((s) => s.source.startsWith("https://"))).toBe(true);
  });

  test("only an admin brings them in", async () => {
    const stranger = await seedAdmin(app, { username: "nora", email: "n@f.dev", password: "mirror-password" });
    expect((await mirrorPacks(app, undefined, source())).ok).toBe(false);
    expect((await mirrorPacks(app, { ...stranger.ok ? stranger.value : admin, isAdmin: false }, source())).ok).toBe(false);
    expect(getRepo(app.db, "packs", "demo")).toBeUndefined();
  });

  test("an admin brings one in: public, on the upstream's branch, with its commits", async () => {
    first = await commit("one\n");
    const done = await mirrorPacks(app, admin, source());
    expect(done.ok && done.value).toMatchObject({ made: ["packs/demo"], kept: [], failed: [] });
    const repo = getRepo(app.db, "packs", "demo")!;
    expect(repo.visibility).toBe("public");
    expect(repo.defaultBranch).toBe("trunk");
    // The request makes the repository and its follow; the first sync is the schedule's.
    expect((await runGit(["rev-parse", "--verify", "refs/heads/trunk"], { cwd: repoDir(app.reposRoot, "packs", "demo"), env: ident })).ok).toBe(false);
    expect(await checkDue(app)).toBeGreaterThanOrEqual(1);
    expect(await git(repoDir(app.reposRoot, "packs", "demo"), "rev-parse", "refs/heads/trunk")).toBe(first);
    expect(listFollowing(app.db).map((f) => f.repoId)).toEqual([repo.id]);
  });

  test("running it twice opens nothing new", async () => {
    const repos = listEveryRepo(app.db).length;
    const again = await mirrorPacks(app, admin, source());
    expect(again.ok && again.value).toMatchObject({ made: [], kept: ["packs/demo"], failed: [] });
    expect(listEveryRepo(app.db).length).toBe(repos);
    expect(listFollowing(app.db).length).toBe(1);
  });

  test("a new upstream commit arrives on the next scheduled sync, with no pull", async () => {
    const second = await commit("two\n");
    expect(await checkDue(app, Date.now() + FOLLOW_EVERY_MS + 1000)).toBeGreaterThanOrEqual(1);
    const dir = repoDir(app.reposRoot, "packs", "demo");
    expect(await git(dir, "rev-parse", "refs/heads/trunk")).toBe(second);
    expect(await git(dir, "branch", "--list", "upstream/*")).toBe("");
  });

  test("a push by anyone, the owner included, is refused", async () => {
    const owner = getUserByName(app.db, "packs")!;
    const ownerCookie = `forge_session=${createSession(app.db, owner.id).token}`;
    const adminSession = await adminCookie(app, { username: "ada", email: "ada@f.dev", password: "mirror-password" });
    for (const cookie of [ownerCookie, adminSession]) {
      const adv = await fetch(`${servers.url}/packs/demo.git/info/refs?service=git-receive-pack`, { headers: { cookie } });
      expect(await adv.text()).not.toContain("refs/heads");
      const body = await fetch(`${servers.url}/packs/demo.git/git-receive-pack`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-git-receive-pack-request" },
        body: "0000",
      });
      expect(body.status).toBe(403);
    }
    // The owner is told why, not just "not found".
    const told = await fetch(`${servers.url}/packs/demo.git/info/refs?service=git-receive-pack`, { headers: { cookie: ownerCookie } });
    expect(await told.text()).toContain(MIRROR_PUSH_REFUSED);
  });

  test("an ssh push is refused with the reason, an ssh clone is served", async () => {
    const push = sshSession("git-receive-pack '/packs/demo.git'");
    await serveGitCommand(app, push.session, admin);
    expect(push.code()).toBe(1);
    expect(push.err.join("")).toContain(MIRROR_PUSH_REFUSED);
    const pull = sshSession("git-upload-pack '/packs/demo.git'");
    await serveGitCommand(app, pull.session, admin);
    expect(pull.code()).toBe(0);
  });

  test("no one but the follow writes a mirror: not an admin, not by the contents api", async () => {
    const repo = getRepo(app.db, "packs", "demo")!;
    expect(canWrite(app.db, repo, admin)).toBe(false);
    expect(canWrite(app.db, repo, getUserByName(app.db, "packs"))).toBe(true);
    const cookie = `forge_session=${createSession(app.db, admin.id).token}`;
    const before = await git(repoDir(app.reposRoot, "packs", "demo"), "rev-parse", "refs/heads/trunk");
    const wrote = await fetch(`${servers.url}/api/v1/repos/packs/demo/contents`, {
      method: "POST",
      headers: { cookie, origin: servers.url, "content-type": "application/json" },
      body: JSON.stringify({ branch: "trunk", message: "x", files: [{ path: "a.txt", content: "a" }] }),
    });
    expect(wrote.status).toBeGreaterThanOrEqual(400);
    expect(await git(repoDir(app.reposRoot, "packs", "demo"), "rev-parse", "refs/heads/trunk")).toBe(before);
    // An ordinary repository's admin still writes.
    const other = await createRepo(app.db, app.reposRoot, { ownerId: admin.id, name: "plain", visibility: "public" });
    expect(other.ok && canWrite(app.db, other.value, admin)).toBe(true);
  });

  test("a slow run stops at its budget and says what it left", async () => {
    const many = [{ name: "late", source: `http://127.0.0.1:${upstream.port}/up.git`, description: "x" }];
    const done = await mirrorPacks(app, admin, many, 0);
    expect(done.ok && done.value.failed).toEqual([{ app: "late", why: "not reached in time; press again" }]);
    expect(getRepo(app.db, "packs", "late")).toBeUndefined();
  });

  test("the /packs button is an admin's; its post answers with the report", async () => {
    const admin2 = await adminCookie(app, { username: "bianca", email: "b@f.dev", password: "mirror-password" });
    const page = await (await fetch(`${servers.url}/packs`, { headers: { cookie: admin2 } })).text();
    expect(page).toContain('action="/packs/mirror"');
    expect(await (await fetch(`${servers.url}/packs`)).text()).not.toContain('action="/packs/mirror"');
    const anon = await fetch(`${servers.url}/packs/mirror`, { method: "POST", redirect: "manual", headers: { origin: servers.url } });
    expect([403, 404]).toContain(anon.status);
    // Every shipped source already has its mirror, so the post reaches no network.
    const owner = getUserByName(app.db, "packs")!;
    for (const p of packSources()) {
      if (getRepo(app.db, "packs", p.name) === undefined)
        await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: p.name, visibility: "public" });
    }
    const posted = await fetch(`${servers.url}/packs/mirror`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: admin2, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe("/packs");
    const flash = decodeURIComponent(posted.headers.get("set-cookie") ?? "");
    expect(flash).toContain("already there");
    expect(flash).toContain("0 brought in");
  });

  test("the MCP door answers an admin with the report, and refuses anyone else", async () => {
    const ctx = { app } as never;
    const denied = await tool.run(ctx, { ...admin, isAdmin: false }, { mirrorPacks: true });
    expect(denied.ok).toBe(false);
    const done = await tool.run(ctx, admin, { mirrorPacks: true });
    expect(done.ok).toBe(true);
    const value = (done as unknown as { value: Record<string, unknown> }).value ?? done;
    const text = JSON.stringify(value);
    expect(text).toContain('"made":[]');
    expect(text).toContain(`"kept":[`);
    expect(text).toContain(reportWords({ made: [], kept: packSources().map((p) => `packs/${p.name}`), failed: [] }).replace(/\./g, "."));
  });

  describe("the terminal door", () => {
    const open = (user: User | undefined) =>
      createForgeApp(app, { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user }, { terminal: headlessTerminal(120, 40), exitHooks: false });
    test("an admin is offered it and a non-admin is not", () => {
      const a = open(admin);
      const ids = forgeCommands(a.session)(a.app.ctx).map((c) => c.id);
      a.app.stop?.();
      const n = open({ ...admin, isAdmin: false });
      const idsN = forgeCommands(n.session)(n.app.ctx).map((c) => c.id);
      n.app.stop?.();
      expect(ids).toContain("mirror-packs");
      expect(idsN).not.toContain("mirror-packs");
    });
    test("Enter runs the action and the screen says what it did", async () => {
      const { app: tui, session } = open(admin);
      tui.start();
      tui.ctx.push(mirrorPacksScreen(session, tui.ctx));
      await settleApp(tui);
      tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("already there");
      tui.stop?.();
    });
  });
});
