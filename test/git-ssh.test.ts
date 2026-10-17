/**
 * `git clone ssh://…` against the forge's own SSH listener, driving the real
 * git and ssh binaries. The point is the auth matrix, which must be the same
 * one smart HTTP enforces:
 *
 *   read   public  guest    → allowed
 *   read   private guest    → not found (never "forbidden")
 *   write  any     reader   → refused
 *   write  own     writer   → allowed, and the hooks fire (push event,
 *                             protected-branch force push refused)
 *   write  missing writer   → push-to-create, same as HTTP
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { addSshKey, signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { getRepo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { quietLogs } from "./helpers/globals.ts";
import { runGitService, type GitChannel } from "../src/git/smart-ssh.ts";
import { serveForgeSsh } from "../src/tui/ssh.ts";
import type { SshServer } from "../src/ssh/server.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { missing } from "./helpers/tools.ts";
import { fixtureSlot } from "./helpers/slot.ts";

quietLogs();

const SSH_KEYGEN = "/usr/bin/ssh-keygen";
/** The client half is the real OpenSSH; without it these skip, loudly. */
const NO_OPENSSH = missing("/usr/bin/ssh", SSH_KEYGEN);

interface Run {
  code: number;
  out: string;
  err: string;
}

describe.skipIf(NO_OPENSSH)("git over ssh", () => {
  let dataDir: string;
  let keyDir: string;
  let work: string;
  let forge: Forge;
  let servers: Servers;
  let server: SshServer;
  let alice: User;
  let bob: User;

  const env = (key: string): Record<string, string> =>
    gitClientEnv({
      GIT_SSH_COMMAND: `/usr/bin/ssh -i ${key} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR -o ConnectTimeout=5`,
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "tester@forge.test",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "tester@forge.test",
    });

  /** `git push` is blocked at the shell level, so every client call spawns. */
  async function git(
    args: string[],
    o: { cwd: string; key: string },
  ): Promise<Run> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: o.cwd,
      env: env(o.key),
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

  const url = (owner: string, name: string): string =>
    `ssh://git@127.0.0.1:${server.port}/${owner}/${name}.git`;

  async function keygen(path: string): Promise<string> {
    const proc = Bun.spawn(
      [SSH_KEYGEN, "-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", path],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    return (await readFile(`${path}.pub`, "utf8")).trim();
  }

  let aliceKey = "";
  let bobKey = "";
  let strangerKey = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-gitssh-"));
    keyDir = await mkdtemp(join(tmpdir(), "forge-gitsshkeys-"));
    work = await mkdtemp(join(tmpdir(), "forge-gitsshwork-"));
    forge = createApp({ dataDir, port: 0 });
    servers = await serve(forge); // the hook socket lives here

    const a = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    }, { slot: fixtureSlot(forge) });
    const b = await signUp(forge, {
      username: "bob",
      email: "bob@forge.test",
      password: "another-long-passphrase",
    }, { slot: fixtureSlot(forge) });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;

    aliceKey = join(keyDir, "alice");
    bobKey = join(keyDir, "bob");
    strangerKey = join(keyDir, "stranger");
    const aLine = await keygen(aliceKey);
    const bLine = await keygen(bobKey);
    await keygen(strangerKey);
    addSshKey(forge, alice, { name: "alice laptop", key: aLine });
    addSshKey(forge, bob, { name: "bob laptop", key: bLine });

    const open = await createRepo(forge, alice, {
      name: "beacon",
      visibility: "public",
    });
    const shut = await createRepo(forge, alice, { name: "vault" });
    if (!open.ok || !shut.ok) throw new Error("repo creation failed");
    await commitToBranch(forge, alice, open.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# Beacon\n" }],
    });
    await commitToBranch(forge, alice, shut.value, {
      message: "seed",
      files: [{ path: "secret", content: "shh\n" }],
    });

    server = await serveForgeSsh(forge, { port: 0, hostname: "127.0.0.1" });
  });

  afterAll(async () => {
    server.stop();
    servers.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(keyDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("a guest clones a public repo", async () => {
    const run = await git(["clone", url("alice", "beacon"), "guest-beacon"], {
      cwd: work,
      key: strangerKey,
    });
    expect(run.code).toBe(0);
    expect(
      await readFile(join(work, "guest-beacon", "README.md"), "utf8"),
    ).toContain("Beacon");
  });

  test("a guest cannot clone a private repo, and is told nothing else", async () => {
    const run = await git(["clone", url("alice", "vault"), "guest-vault"], {
      cwd: work,
      key: strangerKey,
    });
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("repository not found");
    expect(run.err).not.toContain("permission");
  });

  test("a writer pushes, and the push lands in the outbox", async () => {
    const clone = await git(["clone", url("alice", "beacon"), "alice-beacon"], {
      cwd: work,
      key: aliceKey,
    });
    expect(clone.code).toBe(0);
    const repo = join(work, "alice-beacon");
    await Bun.write(join(repo, "light.txt"), "on\n");
    await git(["add", "."], { cwd: repo, key: aliceKey });
    await git(["commit", "-m", "turn it on"], { cwd: repo, key: aliceKey });
    const push = await git(["push", "origin", "main"], {
      cwd: repo,
      key: aliceKey,
    });
    expect(push.code).toBe(0);

    const beacon = getRepo(forge.db, "alice", "beacon")!;
    const dir = repoDir(forge.reposRoot, "alice", "beacon");
    const tip = await runGit(["rev-parse", "refs/heads/main"], { cwd: dir });
    expect(tip.ok).toBe(true);
    // The post-receive hook relayed through the socket, so the event is real.
    await Bun.sleep(200);
    expect(
      listEvents(forge.db, { repoId: beacon.id }).map((e) => e.kind),
    ).toContain("push");
  });

  test("a reader cannot push", async () => {
    const clone = await git(["clone", url("alice", "beacon"), "bob-beacon"], {
      cwd: work,
      key: bobKey,
    });
    expect(clone.code).toBe(0);
    const repo = join(work, "bob-beacon");
    await Bun.write(join(repo, "graffiti.txt"), "hi\n");
    await git(["add", "."], { cwd: repo, key: bobKey });
    await git(["commit", "-m", "sneak"], { cwd: repo, key: bobKey });
    const push = await git(["push", "origin", "main"], {
      cwd: repo,
      key: bobKey,
    });
    expect(push.code).not.toBe(0);
    expect(push.err).toContain("repository not found");
  });

  test("a force push to a protected default branch is refused by the hook", async () => {
    const beacon = getRepo(forge.db, "alice", "beacon")!;
    const protectedRepo = await updateRepoSettings(forge, alice, beacon, {
      protectDefault: true,
    });
    expect(protectedRepo.ok).toBe(true);

    const repo = join(work, "alice-beacon");
    await git(["reset", "--hard", "HEAD~1"], { cwd: repo, key: aliceKey });
    await Bun.write(join(repo, "rewrite.txt"), "history\n");
    await git(["add", "."], { cwd: repo, key: aliceKey });
    await git(["commit", "-m", "rewrite"], { cwd: repo, key: aliceKey });
    const push = await git(["push", "--force", "origin", "main"], {
      cwd: repo,
      key: aliceKey,
    });
    expect(push.code).not.toBe(0);
    expect(push.err).toContain("protected");
  });

  test("push-to-create makes a private repo, exactly as HTTP does", async () => {
    const fresh = join(work, "fresh");
    await Bun.write(join(fresh, "a.txt"), "one\n");
    await git(["init", "-b", "main"], { cwd: fresh, key: aliceKey });
    await git(["add", "."], { cwd: fresh, key: aliceKey });
    await git(["commit", "-m", "first"], { cwd: fresh, key: aliceKey });
    const push = await git(["push", url("alice", "sparkler"), "main"], {
      cwd: fresh,
      key: aliceKey,
    });
    expect(push.code).toBe(0);
    const made = getRepo(forge.db, "alice", "sparkler");
    expect(made).toBeDefined();
    expect(made?.visibility).toBe("private");
  });

  test("a stranger cannot push-to-create under someone else's name", async () => {
    const fresh = join(work, "stranger");
    await Bun.write(join(fresh, "a.txt"), "one\n");
    await git(["init", "-b", "main"], { cwd: fresh, key: strangerKey });
    await git(["add", "."], { cwd: fresh, key: strangerKey });
    await git(["commit", "-m", "first"], { cwd: fresh, key: strangerKey });
    const push = await git(["push", url("alice", "intruder"), "main"], {
      cwd: fresh,
      key: strangerKey,
    });
    expect(push.code).not.toBe(0);
    expect(getRepo(forge.db, "alice", "intruder")).toBeUndefined();
  });

  test("anything that is not a git service is refused with a hint", async () => {
    const proc = Bun.spawn(
      [
        "/usr/bin/ssh",
        "-p",
        String(server.port),
        "-i",
        aliceKey,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "LogLevel=ERROR",
        "git@127.0.0.1",
        "id",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [err, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(err).toContain("only git is available over ssh");
  });
});

/**
 * A hand-driven `GitChannel`. The transport is proven above with real git and
 * real ssh; what this isolates is the lifetime rule those tests cannot make
 * visible — whether the child outlives a peer that walked away.
 */
describe.skipIf(NO_OPENSSH)("a git service outlives neither the channel nor the peer", () => {
  let dataDir: string;
  let forge: Forge;
  let dir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-gitkill-"));
    forge = createApp({ dataDir, port: 0 });
    const alice = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    }, { slot: fixtureSlot(forge) });
    if (!alice.ok) throw new Error("signup failed");
    const repo = await createRepo(forge, alice.value, {
      name: "lighthouse",
      visibility: "public",
    });
    if (!repo.ok) throw new Error("repo failed");
    await commitToBranch(forge, alice.value, repo.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# lighthouse\n" }],
    });
    dir = repoDir(forge.reposRoot, "alice", "lighthouse");
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function channel(): GitChannel & {
    eof(): void;
    close(): void;
    stdout(): Uint8Array[];
  } {
    let onEof = (): void => {};
    let onClose = (): void => {};
    const out: Uint8Array[] = [];
    return {
      write: (data) => {
        out.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
      writeStderr: () => {},
      onData: () => {},
      onEof: (cb) => {
        onEof = cb;
      },
      onClose: (cb) => {
        onClose = cb;
      },
      exit: () => {},
      drain: () => Promise.resolve(),
      eof: () => onEof(),
      close: () => onClose(),
      stdout: () => out,
    };
  }

  const settled = async (p: Promise<number>): Promise<boolean> => {
    const marker = Symbol("pending");
    const race = await Promise.race([
      p,
      new Promise((r) => setTimeout(() => r(marker), 400)),
    ]);
    return race !== marker;
  };

  test("a peer that disconnects mid-transfer kills git at once", async () => {
    const ch = channel();
    // A ten-minute timeout, so nothing but the close can end this.
    const running = runGitService(dir, "git-upload-pack", ch, {
      timeoutMs: 600_000,
    });
    // upload-pack advertises its refs and then waits on stdin forever: with
    // no close, the transfer is still open.
    expect(await settled(running)).toBe(false);
    expect(ch.stdout().length).toBeGreaterThan(0);

    ch.close();
    const code = await Promise.race([
      running,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("git outlived the channel")), 5_000),
      ),
    ]);
    expect(typeof code).toBe("number");
  }, 15_000);

  test("EOF still ends git's stdin, so a half-closed client is not left hanging", async () => {
    const ch = channel();
    const running = runGitService(dir, "git-upload-pack", ch, {
      timeoutMs: 600_000,
    });
    expect(await settled(running)).toBe(false);
    // The peer half-closed without asking for anything; git ends by itself.
    ch.eof();
    const code = await Promise.race([
      running,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("git ignored the EOF")), 5_000),
      ),
    ]);
    expect(typeof code).toBe("number");
    expect(ch.stdout().length).toBeGreaterThan(0);
  }, 15_000);
});
