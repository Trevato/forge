/**
 * The storage quota (#919): an account with a limit is refused a push past
 * it with a git error, and the repository is as it was; an admin is not
 * held to it, and no limit set means no refusal.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo, deleteRepo, forkRepo } from "../src/actions/repos.ts";
import { makeItYours } from "../src/actions/make_it_yours.ts";
import { newApp } from "../src/actions/apps.ts";
import { signUp } from "../src/actions/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { REWALK_MS, accountBytes, formatBytes, storageRefusal } from "../src/core/storage.ts";
import { getRepo } from "../src/core/repos.ts";
import { createAgent } from "../src/actions/crew.ts";
import { mirrorAndWait, newFakeState, serveFakeForge } from "./fake-origin.ts";
import { serveGitCommand } from "../src/tui/ssh.ts";
import type { SshSession } from "../src/ssh/channels.ts";
import { getUserById } from "../src/core/users.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import { setQuota } from "../src/settings/quotas.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("storage quota", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let adaId: string;
  let adaToken: string;
  let bobId: string;
  let bobToken: string;
  let carolId: string;
  let carolToken: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-quotas-storage-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const ada = await seedAdmin(app, { username: "ada", email: "ada@f.dev", password: "owner-passphrase" });
    const bob = await signUp(app, { username: "bob", email: "bob@f.dev", password: "bob-passphrase" }, { slot: fixtureSlot(app) });
    const carol = await signUp(app, { username: "carol", email: "carol@f.dev", password: "carol-passphrase" }, { slot: fixtureSlot(app) });
    if (!ada.ok || !bob.ok || !carol.ok) throw new Error("signup");
    carolId = carol.value.id;
    carolToken = createToken(app.db, carolId, "t", "admin").token;
    proveAll(app);
    promote(app.db);
    expect(ada.value.isAdmin).toBe(true);
    expect(bob.value.isAdmin).toBe(false);
    adaId = ada.value.id;
    bobId = bob.value.id;
    adaToken = createToken(app.db, adaId, "t", "admin").token;
    bobToken = createToken(app.db, bobId, "t", "admin").token;
    setQuota(app.db, "storage", 1, adaId); // one megabyte
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Commit `bytes` of random data in a fresh clone and push it to `owner/name`. */
  async function push(owner: string, token: string, name: string, bytes: number) {
    const work = await mkdtemp(join(tmpdir(), "forge-storage-push-"));
    try {
      const env = gitClientEnv({
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@f.dev",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@f.dev",
      });
      const git = async (args: string[]) => {
        const proc = Bun.spawn(["git", ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
        const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        return { code, err };
      };
      await git(["init", "-q", "-b", "main"]);
      await writeFile(join(work, "blob.bin"), crypto.getRandomValues(new Uint8Array(bytes)));
      await git(["add", "."]);
      await git(["commit", "-q", "-m", "data"]);
      const remote = `${servers.url.replace("http://", `http://${owner}:${token}@`)}/${owner}/${name}.git`;
      return await git(["push", "-q", remote, "main"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  const refs = (owner: string, name: string): string =>
    Bun.spawnSync(["git", "--git-dir", join(dataDir, "repos", owner, `${name}.git`), "for-each-ref"], {
      env: gitClientEnv({}),
    }).stdout.toString();

  test("formats like a person says it", () => {
    expect(formatBytes(1_900_000_000)).toBe("1.9 GB");
    expect(formatBytes(2_000_000_000)).toBe("2 GB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
  });

  test("a push past the limit is refused by git and leaves the repository as it was", async () => {
    const pushed = await push("bob", bobToken, "big", 1_500_000);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("pack exceeds maximum allowed size");
    expect(refs("bob", "big")).toBe("");
  });

  test("an account at the limit is refused the next push, create and fork, with its use named", async () => {
    setQuota(app.db, "storage", 2, adaId);
    const first = await push("bob", bobToken, "ok", 1_500_000);
    expect(first.code).toBe(0);
    expect(refs("bob", "ok")).not.toBe("");
    // The measuring is off the request path: wait for the refresh the push began.
    for (let i = 0; i < 100 && (await accountBytes(app, bobId)) < 1_500_000; i++)
      await Bun.sleep(20);
    if ((await accountBytes(app, bobId)) < 1_500_000) throw new Error(`never came: still waiting while (await accountBytes(app, bobId)) < 1_500_000`);
    setQuota(app.db, "storage", 1, adaId);
    const third = await push("bob", bobToken, "ok", 10);
    expect(third.code).not.toBe(0);
    expect(third.err).toContain("MB of 1 MB");

    const made = await createRepo(app, getUserById(app.db, bobId)!, { name: "more", visibility: "private" });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error).toBe("storage_limit");
  });

  test("push-to-create over the limit is a git error naming the use, not a not-found", async () => {
    const pushed = await push("bob", bobToken, "fresh", 10);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("MB of 1 MB");
    expect(pushed.err).not.toContain("not found");
  });

  test("over ssh the refusal is a git error too, before git runs", async () => {
    const lines: string[] = [];
    let exited: number | undefined;
    const session = {
      command: "git-receive-pack '/bob/ok.git'",
      username: "git",
      env: {},
      writeStderr: (d: string | Uint8Array) => void lines.push(String(d)),
      write: () => {},
      exit: (code: number) => void (exited = code),
      onData: () => {},
      onEof: () => {},
      onClose: () => {},
      drain: async () => {},
    } as unknown as SshSession;
    await serveGitCommand(app, session, getUserById(app.db, bobId));
    expect(exited).toBe(1);
    expect(lines.join("")).toContain("storage limit reached: ");
    expect(lines.join("")).toContain("MB of 1 MB");
  });

  test("forks that fill the limit end in a refused fork", async () => {
    const filled = await push("carol", carolToken, "base", 900_000);
    expect(filled.code).toBe(0);
    const carol = getUserById(app.db, carolId)!;
    const ada = getUserById(app.db, adaId)!;
    let refused: string | undefined;
    let made = 0;
    for (let i = 0; i < 60 && refused === undefined; i++) {
      const parent = await createRepo(app, ada, { name: `src${i}`, visibility: "public" });
      if (!parent.ok) throw new Error(parent.error);
      await commitToBranch(app, ada, parent.value, {
        message: "seed",
        files: [{ path: "a.txt", content: "a\n" }],
      });
      const forked = await forkRepo(app, carol, parent.value);
      if (forked.ok) made++;
      else refused = forked.error;
    }
    expect(made).toBeGreaterThan(0);
    expect(refused).toBe("storage_limit");
  });

  test("an agent is not held to the limit, the account beside it is", async () => {
    const carol = getUserById(app.db, carolId)!;
    const agent = await createAgent(app, getUserById(app.db, adaId)!, { username: "worker" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(await storageRefusal(app, carol, carolId)).toContain("MB of 1 MB");
    expect(await storageRefusal(app, agent.value.user, carolId)).toBeUndefined();
  });

  test("a mirror by an account at the limit is refused and leaves nothing behind", async () => {
    const state = newFakeState("forgejo", "someone", "tok");
    state.repos.push({
      id: 1,
      fullName: "someone/gears",
      cloneUrl: "http://127.0.0.1:1/someone/gears.git",
      defaultBranch: "main",
    });
    const fake = serveFakeForge(state);
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${servers.url}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${carolToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const connected = await post("/api/v1/user/origins", { host: fake.url, token: "tok" });
      expect(connected.status).toBe(201);
      const originId = ((await connected.json()) as { id: string }).id;
      const job = await mirrorAndWait(
        await post(`/api/v1/user/origins/${originId}/mirror`, { fullName: "someone/gears" }),
      );
      expect(job?.stage).toBe("failed");
      expect(job?.error).toContain("Not mirrored: ");
      expect(job?.error).toContain("MB of 1 MB");
      expect(getRepo(app.db, "carol", "gears")).toBeUndefined();
    } finally {
      fake.stop();
    }
  });

  test("an account at its limit deletes a repository and pushes again, with no restart", async () => {
    const bob = getUserById(app.db, bobId)!;
    const refusedBefore = await push("bob", bobToken, "ok", 10);
    expect(refusedBefore.code).not.toBe(0);
    for (const name of ["ok", "big", "fresh"]) {
      const repo = getRepo(app.db, "bob", name);
      if (repo) expect((await deleteRepo(app, bob, repo)).ok).toBe(true);
    }
    const after = await push("bob", bobToken, "again", 100_000);
    expect(after.code).toBe(0);
  });

  test("an admin is not held to it", async () => {
    const pushed = await push("ada", adaToken, "huge", 3_000_000);
    expect(pushed.code).toBe(0);
    expect(refs("ada", "huge")).not.toBe("");
  });

  test("a mirror bigger than the limit is allowed in, and the next create is refused as storage_limit", async () => {
    // The origin: a public repository of 1.5 MB on this same forge.
    expect((await push("ada", adaToken, "bigorigin", 1_500_000)).code).toBe(0);
    app.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'bigorigin'").run();
    const dave = await signUp(app, { username: "dave", email: "dave@f.dev", password: "dave-passphrase" }, { slot: fixtureSlot(app) });
    if (!dave.ok) throw new Error("signup");
    proveAll(app);
    promote(app.db);
    const daveToken = createToken(app.db, dave.value.id, "t", "admin").token;
    const state = newFakeState("forgejo", "someone", "tok");
    state.repos.push({
      id: 2,
      fullName: "ada/bigorigin",
      cloneUrl: `${servers.url}/ada/bigorigin.git`,
      defaultBranch: "main",
    });
    const fake = serveFakeForge(state);
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${servers.url}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${daveToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const connected = await post("/api/v1/user/origins", { host: fake.url, token: "tok" });
      const originId = ((await connected.json()) as { id: string }).id;
      // Empty at the start, so the mirror is let in; the figure is read once.
      expect(await accountBytes(app, dave.value.id)).toBe(0);
      const job = await mirrorAndWait(
        await post(`/api/v1/user/origins/${originId}/mirror`, { fullName: "ada/bigorigin" }),
      );
      expect(job?.stage).toBe("done");
      // The fetch marked the figure stale, so this check walks it and refuses.
      const made = await createRepo(app, getUserById(app.db, dave.value.id)!, {
        name: "more",
        visibility: "private",
      });
      expect(made).toEqual({ ok: false, error: "storage_limit" });
      const api = await post("/api/v1/repos", { name: "more" });
      expect(api.status).toBe(403);
      expect(await api.json()).toMatchObject({ error: "storage_limit" });
    } finally {
      fake.stop();
    }
  });

  test("a migrate import bigger than the limit is allowed in, and the next create is refused as storage_limit", async () => {
    const gina = await signUp(app, { username: "gina", email: "gina@f.dev", password: "gina-passphrase" }, { slot: fixtureSlot(app) });
    if (!gina.ok) throw new Error("signup");
    proveAll(app);
    promote(app.db);
    const token = createToken(app.db, gina.value.id, "t", "admin").token;
    const state = newFakeState("forgejo", "someone", "tok");
    state.repos.push({
      id: 3,
      fullName: "ada/bigorigin",
      cloneUrl: `${servers.url}/ada/bigorigin.git`,
      defaultBranch: "main",
    });
    const fake = serveFakeForge(state);
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${servers.url}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const connected = await post("/api/v1/user/origins", { host: fake.url, token: "tok" });
      const originId = ((await connected.json()) as { id: string }).id;
      expect(await accountBytes(app, gina.value.id)).toBe(0);
      const job = await mirrorAndWait(
        await post("/api/v1/migrate", { source: { originId, fullName: "ada/bigorigin" }, name: "moved" }),
      );
      expect(job?.stage).toBe("done");
      const made = await createRepo(app, getUserById(app.db, gina.value.id)!, {
        name: "more",
        visibility: "private",
      });
      expect(made).toEqual({ ok: false, error: "storage_limit" });
    } finally {
      fake.stop();
    }
  });

  /** A fresh account holding 1.5 MB, its figure measured, against the 1 MB limit. */
  async function fullAccount(username: string) {
    const made = await signUp(app, { username, email: `${username}@f.dev`, password: `${username}-passphrase` }, { slot: fixtureSlot(app) });
    if (!made.ok) throw new Error("signup");
    proveAll(app);
    promote(app.db);
    setQuota(app.db, "storage", 2, adaId);
    const token = createToken(app.db, made.value.id, "t", "admin").token;
    expect((await push(username, token, "data", 1_500_000)).code).toBe(0);
    for (let i = 0; i < 100 && (await accountBytes(app, made.value.id)) < 1_500_000; i++)
      await Bun.sleep(20);
    if ((await accountBytes(app, made.value.id)) < 1_500_000) throw new Error(`never came: still waiting while (await accountBytes(app, made.value.id)) < 1_500_000`);
    setQuota(app.db, "storage", 1, adaId);
    return getUserById(app.db, made.value.id)!;
  }

  test("an account at the limit is measured again at most every REWALK_MS", async () => {
    expect(REWALK_MS).toBe(5_000);
    const erin = await fullAccount("erin");
    expect(await storageRefusal(app, erin, erin.id)).toContain("MB of 1 MB");
    // The disk is emptied behind the cache's back.
    await rm(join(dataDir, "repos", "erin"), { recursive: true, force: true });
    const now = Date.now();
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(now + REWALK_MS - 1_000);
      expect(await storageRefusal(app, erin, erin.id)).toContain("MB of 1 MB");
      clock.mockReturnValue(now + REWALK_MS + 1_000);
      expect(await storageRefusal(app, erin, erin.id)).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  test("a copy over the storage limit is a storage_limit, not a raw code", async () => {
    const source = await newApp(app, getUserById(app.db, adaId)!, { name: "garden", visibility: "public" });
    if (!source.ok) throw new Error(String(source.error));
    const frank = await fullAccount("frank");
    const copy = await makeItYours(app, frank, source.value.repo, { dryRun: false });
    expect(copy.ok).toBe(false);
    if (!copy.ok) {
      expect(copy.error.kind).toBe("storage_limit");
      if (copy.error.kind === "storage_limit") expect(copy.error.message).toContain("MB of 1 MB");
    }
  });

  test("a create under a full organisation names the organisation's figure on the page", async () => {
    const gwen = await signUp(app, { username: "gwen", email: "gwen@f.dev", password: "gwen-passphrase" }, { slot: fixtureSlot(app) });
    if (!gwen.ok) throw new Error("signup");
    proveAll(app);
    promote(app.db);
    const org = createOrg(app.db, "guild", gwen.value.id);
    if (!org.ok) throw new Error("org");
    setQuota(app.db, "storage", 2, adaId);
    const token = createToken(app.db, gwen.value.id, "t", "admin").token;
    const made = await createRepo(app, gwen.value, { owner: "guild", name: "big", visibility: "private", description: "" });
    expect(made.ok).toBe(true);
    expect((await push("guild", token, "big", 1_500_000)).code).toBe(0);
    for (let i = 0; i < 100 && (await accountBytes(app, org.value.id)) < 1_500_000; i++)
      await Bun.sleep(20);
    if ((await accountBytes(app, org.value.id)) < 1_500_000) throw new Error(`never came: still waiting while (await accountBytes(app, org.value.id)) < 1_500_000`);
    setQuota(app.db, "storage", 1, adaId);
    // Gwen herself holds nothing: only the organisation is over.
    expect(await accountBytes(app, gwen.value.id)).toBe(0);
    const res = await fetch(`${servers.url}/new`, {
      method: "POST",
      headers: {
        cookie: `forge_session=${createSession(app.db, gwen.value.id).token}`,
        origin: servers.url,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ owner: "guild", name: "more", visibility: "private" }),
      redirect: "manual",
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("MB of 1 MB");
  });

  test("with no limit set nothing is refused", async () => {
    setQuota(app.db, "storage", null, adaId);
    const pushed = await push("bob", bobToken, "free", 1_500_000);
    expect(pushed.code).toBe(0);
  });
});
