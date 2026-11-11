/**
 * Repo transfer, step two (#570): a repository moves with a fork, a running
 * preview and a deploy waiting its turn, and each follows it. The waiting
 * deploy runs against the new place on disk; the preview and production
 * start again holding the new owner's token; the fork keeps its parent and
 * reads its objects; a run token bound to the repository reaches it through
 * the old path; git over HTTPS fetches the old URL; git over SSH serves the
 * old path with one line naming the new remote, and refuses a push there.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { transferRepository } from "../src/actions/transfer.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { forkRepo, getRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { mintRunToken } from "../src/core/run_token.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { verifyToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { SshSession } from "../src/ssh/channels.ts";
import { serveGitCommand } from "../src/tui/ssh.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
/** The app answers with the forge token it was started with, so a test can ask whose it is. */
const SERVER = `Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1",
  fetch: () => new Response(process.env.FORGE_TOKEN ?? "none") });
`;
const MANIFEST = `${JSON.stringify({ app: { run: "bun run server.ts" } })}\n`;

const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim(), err };
};

/** An exec channel driven by hand: the client sends a flush (it wants nothing) and hangs up. */
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

describe("a moved repository's fork, preview, queued deploy and remotes follow it", () => {
  let dataDir = "";
  let work = "";
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let carol: User;
  let before: Repo;
  let record: AppRecord;
  let fork: Repo;
  let pullNumber = 0;
  let queued: Run;
  let tip = "";

  async function until<T>(read: () => T | undefined, what: string, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(25);
    }
    throw new Error(`${what} did not happen in time`);
  }
  const runs = () => listRuns(app.db, before.id, { kind: "deploy", limit: 50 });
  const settled = (where: (r: Run) => boolean, what: string) =>
    until(() => runs().find((r) => where(r) && r.state !== "queued" && r.state !== "running"), what);
  const viaHost = async (host: string) =>
    (await fetch(`${servers.url}/`, { headers: { host }, redirect: "manual" })).text();
  const ownerOfServed = async (host: string) => {
    const held = verifyToken(app.db, await viaHost(host));
    return held.ok ? held.value.user.username : "none";
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-transfer-follow-"));
    work = await mkdtemp(join(tmpdir(), "forge-transfer-follow-wc-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const mk = async (username: string): Promise<User> => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-long-follow-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!u.ok) throw new Error(JSON.stringify(u.error));
      return u.value;
    };
    alice = await mk("alice");
    await mk("bob");
    carol = await mk("carol");
    const made = await createRepo(app, alice, { name: "lab", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    before = made.value;
    const first = await commitToBranch(app, alice, before, {
      message: "first",
      files: [
        { path: "forge.json", content: MANIFEST },
        { path: "server.ts", content: SERVER },
      ],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const enabled = enableApp(app, alice, before, { slug: "lab" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = enabled.value;
    const prod = await settled((r) => r.env === "production", "production's first deploy");
    if (prod.state !== "ok") throw new Error(`production: ${prod.summary}`);

    const branch = await commitToBranch(app, alice, before, {
      branch: "feat",
      base: "main",
      message: "feat",
      files: [{ path: "feat.txt", content: "feat\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, before, { title: "feat", baseBranch: "main", headBranch: "feat" });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    pullNumber = opened.value.number;
    const preview = await settled((r) => r.env === `pull-${pullNumber}`, "the preview");
    if (preview.state !== "ok") throw new Error(`preview: ${preview.summary}`);
    expect(await ownerOfServed(`lab--${pullNumber}.${DOMAIN}`)).toBe("alice");

    const forked = await forkRepo(app.db, app.reposRoot, before, carol.id);
    if (!forked.ok) throw new Error(String(forked.error));
    fork = forked.value;

    // Every permit taken: the next deploy is claimed and waits its turn,
    // holding the repository as it was asked for — at alice/lab.
    const release = await runtime.lane.acquire();
    const second = await commitToBranch(app, alice, before, {
      message: "second",
      files: [{ path: "second.txt", content: "second\n" }],
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    tip = second.value.commitOid;
    queued = await until(
      () => runs().find((r) => r.env === "production" && r.commitOid === tip && r.state === "running"),
      "the waiting deploy",
    );
    const moved = await transferRepository(app, alice, before, "bob");
    if (!moved.ok) throw new Error(moved.error);
    release();
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("the deploy that waited runs against the new place and serves", async () => {
    const done = await settled((r) => r.id === queued.id, "the waiting deploy");
    expect(done.summary).not.toContain("not a git repository");
    expect(done.state).toBe("ok");
  }, 60_000);

  test("production and the running preview start again as the new owner's", async () => {
    for (const env of ["production", `pull-${pullNumber}`]) {
      const again = await settled((r) => r.env === env && r.reason === "moved", `${env} starting again`);
      expect(again.state).toBe("ok");
    }
    await until(
      () => runtime.status(record).find((e) => e.env === "production" && e.commitOid === tip && e.state === "running"),
      "production serving the new tip",
    );
    expect(await ownerOfServed(`lab.${DOMAIN}`)).toBe("bob");
    expect(await ownerOfServed(`lab--${pullNumber}.${DOMAIN}`)).toBe("bob");
  }, 60_000);

  test("the fork keeps its parent and still reads the objects it shares", async () => {
    const now = getRepoById(app.db, fork.id)!;
    expect(now.forkParentId).toBe(before.id);
    const read = await git(repoDir(app.reposRoot, "carol", "lab"), "cat-file", "-t", `${tip}~1`);
    expect(read.out).toBe("commit");
  });

  test("a run token bound to the repository follows the old API path to the new one", async () => {
    const token = mintRunToken(app.db, carol.id, "r1", { repoId: before.id, forkId: fork.id }, "2999-01-01T00:00:00Z").token;
    const headers = { authorization: `Bearer ${token}` };
    const old = await fetch(`${servers.url}/api/v1/repos/alice/lab`, { headers, redirect: "manual" });
    expect(old.status).toBe(308);
    expect(old.headers.get("location")).toBe("/api/v1/repos/bob/lab");
    const there = await fetch(`${servers.url}/api/v1/repos/bob/lab`, { headers });
    expect(there.status).toBe(200);
  });

  test("git fetch against the old HTTPS remote works", async () => {
    expect((await git(work, "clone", `${servers.url}/alice/lab.git`, "wc")).code).toBe(0);
    expect((await git(join(work, "wc"), "fetch", "origin")).code).toBe(0);
    expect((await git(join(work, "wc"), "rev-parse", "origin/main")).out).toBe(tip);
  });

  test("ssh under the old path serves the repository and names the new remote once", async () => {
    const s = sshSession("git-upload-pack '/alice/lab.git'");
    await serveGitCommand(app, s.session, carol);
    expect(s.code()).toBe(0);
    expect(s.out.join("")).toContain(`${tip} HEAD`);
    const said = s.err.join("").split("\n").filter((l) => l.includes("moved to bob/lab"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("git remote set-url origin");
  });

  test("an ssh push to the old path is refused, and does not take the path back", async () => {
    const s = sshSession("git-receive-pack '/alice/lab.git'");
    await serveGitCommand(app, s.session, alice);
    expect(s.code()).toBe(1);
    expect(s.err.join("")).toContain("Nothing was pushed");
    expect(getRepo(app.db, "alice", "lab")).toBeUndefined();
  });

  test("someone who cannot read it gets what a missing path answers", async () => {
    const hidden = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!hidden.ok) throw new Error(String(hidden.error));
    const moved = await transferRepository(app, alice, hidden.value, "bob");
    expect(moved.ok).toBe(true);
    const s = sshSession("git-upload-pack '/alice/vault.git'");
    await serveGitCommand(app, s.session, carol);
    expect(s.code()).toBe(1);
    expect(s.err.join("")).toContain("repository not found: alice/vault");
    expect(s.err.join("")).not.toContain("bob");
  });
});
