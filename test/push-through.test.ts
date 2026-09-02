import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pushToOrigin } from "../src/origins/git-mirror.ts";
import { resetConnectLimit } from "../src/actions/origins.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";

/**
 * Push-through: a `git push` to a mirror lands upstream, or it does not land
 * at all. Two real forges and a real git client, because the interesting
 * part is what happens inside pre-receive — with the pushed objects still in
 * quarantine — and no stub reproduces that.
 */

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-71bd";
const ALICE_PASSWORD = "alice-login-secret";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

const clientEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Alice",
  GIT_AUTHOR_EMAIL: "alice@forge.test",
  GIT_COMMITTER_NAME: "Alice",
  GIT_COMMITTER_EMAIL: "alice@forge.test",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: clientEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

describe("push-through: the origin gets the last word", () => {
  let dataDir: string;
  let originDataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let base: string;
  let clone = "";

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", ALICE_PASSWORD));
    return fetch(`${base}${path}`, { ...init, headers });
  };

  const upstream = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic(ORIGIN_LOGIN, ORIGIN_TOKEN));
    return fetch(`${originServers.url}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pt-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-pt-up-"));
    work = await mkdtemp(join(tmpdir(), "forge-pt-work-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await fetch(`${originServers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: ORIGIN_LOGIN,
        email: "octo@up.test",
        password: ORIGIN_TOKEN,
      }),
    });
    await upstream("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "gears", visibility: "public" }),
    });
    await upstream("/api/v1/repos/octo/gears/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "a.txt", content: "one\n" }],
      }),
    });

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 3,
      fullName: "octo/gears",
      cloneUrl: `${originServers.url}/octo/gears.git`,
      defaultBranch: "main",
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@forge.test",
        password: ALICE_PASSWORD,
      }),
    });
    resetConnectLimit();

    const connected = await read<{ id: string }>(
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
      }),
    );
    await api(`/api/v1/user/origins/${connected.id}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/gears" }),
    });

    clone = join(work, "gears");
    const remote = `http://alice:${ALICE_PASSWORD}@localhost:${servers.port}/alice/gears.git`;
    expect((await git(["clone", "-q", remote, clone], work)).code).toBe(0);
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  // ---- the shape of the mirror on disk ----

  test("a mirror is never armed for a destructive push", async () => {
    const dir = join(dataDir, "repos", "alice", "gears.git");
    // `remote.<x>.mirror` is read by *push*, where it silently means
    // --mirror: force everything under refs/, and DELETE upstream anything
    // missing locally. A stale mirror would then wipe branches nobody here
    // has ever seen. It is pinned false, and this is the test that says so.
    const mirrorFlag = await git(
      ["config", "--get", "remote.origin.mirror"],
      dir,
    );
    expect(mirrorFlag.out).toBe("false");

    const refspecs = await git(
      ["config", "--get-all", "remote.origin.fetch"],
      dir,
    );
    expect(refspecs.out.split("\n")).toEqual([
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ]);
    // No refs/pull/* avalanche: on a real GitHub repo that is thousands of
    // refs against a handful of branches.
    const config = await readFile(join(dir, "config"), "utf8");
    expect(config).not.toContain("refs/pull");
    // And the URL on disk carries no credential.
    expect(config).not.toContain(ORIGIN_TOKEN);
    expect(config).not.toContain("@");
  });

  test("a push with no refspec cannot be built", async () => {
    const refused = await pushToOrigin(
      join(dataDir, "repos", "alice", "gears.git"),
      `${originServers.url}/octo/gears.git`,
      [],
      {},
    );
    expect(refused).toEqual({
      ok: false,
      error: { message: "refusing a push with no refspec" },
    });
  });

  // ---- the happy path ----

  test("a push to the mirror lands on the origin", async () => {
    await Bun.write(join(clone, "b.txt"), "two\n");
    expect((await git(["add", "."], clone)).code).toBe(0);
    expect((await git(["commit", "-q", "-m", "add b"], clone)).code).toBe(0);
    const local = (await git(["rev-parse", "HEAD"], clone)).out;

    const pushed = await git(["push", "-q", "origin", "main"], clone);
    expect(pushed.code).toBe(0);

    // The origin's ref actually moved — this is the whole feature.
    const upstreamBranches = await read<{ name: string; oid: string }[]>(
      await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
    );
    expect(upstreamBranches.find((b) => b.name === "main")?.oid).toBe(local);

    // And the local ref moved too, so the mirror is not behind its origin.
    const localBranches = await read<{ name: string; oid: string }[]>(
      await api("/api/v1/repos/alice/gears/branches"),
    );
    expect(localBranches.find((b) => b.name === "main")?.oid).toBe(local);
  });

  // ---- the refusal path ----

  test("an origin that refuses the push refuses it here too", async () => {
    // Protect the origin's default branch, then rewrite history locally: the
    // origin will reject the force-push, and so must we.
    const protectedNow = await upstream("/api/v1/repos/octo/gears", {
      method: "PATCH",
      body: JSON.stringify({ protectDefault: true }),
    });
    expect(protectedNow.status).toBe(200);

    const before = (await git(["rev-parse", "HEAD"], clone)).out;
    await Bun.write(join(clone, "b.txt"), "two, but different\n");
    await git(["add", "."], clone);
    expect(
      (await git(["commit", "-q", "--amend", "-m", "rewritten"], clone)).code,
    ).toBe(0);
    const rewritten = (await git(["rev-parse", "HEAD"], clone)).out;
    expect(rewritten).not.toBe(before);

    const pushed = await git(
      ["push", "-q", "--force", "origin", "main"],
      clone,
    );
    expect(pushed.code).not.toBe(0);
    // The pusher sees the ORIGIN's reason, not a generic failure.
    expect(pushed.err).toContain("octo/gears");
    expect(pushed.err).toContain("protected");
    // No credential travelled back with it.
    expect(pushed.err).not.toContain(ORIGIN_TOKEN);

    // Nothing moved on either side: the local ref is still the old commit,
    // which is exactly what "the origin is truth" has to mean.
    const localBranches = await read<{ name: string; oid: string }[]>(
      await api("/api/v1/repos/alice/gears/branches"),
    );
    expect(localBranches.find((b) => b.name === "main")?.oid).toBe(before);
    const upstreamBranches = await read<{ name: string; oid: string }[]>(
      await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
    );
    expect(upstreamBranches.find((b) => b.name === "main")?.oid).toBe(before);

    await upstream("/api/v1/repos/octo/gears", {
      method: "PATCH",
      body: JSON.stringify({ protectDefault: false }),
    });
    await git(["reset", "-q", "--hard", before], clone);
  });

  test("a new branch is created upstream, and a deletion is forwarded", async () => {
    await git(["checkout", "-q", "-b", "topic"], clone);
    await Bun.write(join(clone, "c.txt"), "three\n");
    await git(["add", "."], clone);
    await git(["commit", "-q", "-m", "topic work"], clone);
    const tip = (await git(["rev-parse", "HEAD"], clone)).out;

    expect((await git(["push", "-q", "origin", "topic"], clone)).code).toBe(0);
    let upstreamBranches = await read<{ name: string; oid: string }[]>(
      await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
    );
    expect(upstreamBranches.find((b) => b.name === "topic")?.oid).toBe(tip);

    expect((await git(["push", "-q", "origin", ":topic"], clone)).code).toBe(0);
    upstreamBranches = await read<{ name: string; oid: string }[]>(
      await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
    );
    expect(upstreamBranches.map((b) => b.name)).not.toContain("topic");
  });

  test("the forge's own pull namespace never travels upstream", async () => {
    const refused = await git(
      ["push", "origin", "HEAD:refs/pull/1/head"],
      clone,
    );
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("reserved");
  });
});
