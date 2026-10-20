/** A second clone borrows from the repository's mirror; a deleted mirror breaks nothing. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { removeAccount } from "../src/actions/accounts.ts";
import { runGit } from "../src/git/env.ts";
import { createApp } from "../src/app.ts";
import { createRepo, deleteRepo } from "../src/actions/repos.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";
import { cloneWithMirror, mirrorDir } from "../src/crew/mirror.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

let root: string;
let origin: string;
const data = () => join(root, "data");
const sh = (args: string[], cwd: string, env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mirror-"));
  origin = join(root, "origin");
  mkdirSync(origin);
  sh(["init", "-q", "-b", "main"], origin);
  Bun.write(join(origin, "a.txt"), "hello\n");
  sh(["add", "."], origin);
  sh(["commit", "-qm", "one"], origin);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let throwaway = 0;
/** Build (or refresh) a mirror the way a run does: a clone that borrows from it. */
const mirrored = (dataDir: string, repoId: string, signal?: AbortSignal) =>
  cloneWithMirror({
    dataDir, repoId, url: `file://${origin}`, dir: join(root, `throwaway-${throwaway++}`), env: {},
    ...(signal === undefined ? {} : { signal }),
  });

/**
 * An ssh "transport" that logs when each git conversation starts and ends,
 * and sleeps in between, so a test can see which ones overlap.
 */
const slow = (seconds: number) => {
  const script = join(root, "slow-ssh");
  writeFileSync(
    script,
    // GIT_SSH_VARIANT=simple: $1 is the host, $2 the remote command.
    `#!/bin/sh\necho start >> "$SLOW_LOG"\nsleep "$SLOW_SECONDS"\neval "git \${2#git-}"\ncode=$?\necho end >> "$SLOW_LOG"\nexit $code\n`,
  );
  chmodSync(script, 0o755);
  const logFile = join(root, `slow-${throwaway++}.log`);
  writeFileSync(logFile, "");
  return {
    url: `ssh://forge.test${origin}`,
    env: { GIT_SSH_COMMAND: script, GIT_SSH_VARIANT: "simple", SLOW_LOG: logFile, SLOW_SECONDS: String(seconds) },
    log: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean),
  };
};

const wants = (trace: string) =>
  readFileSync(trace, "utf8").split("\n").filter((l) => /packet:\s+fetch< want |packet:\s+clone> want /.test(l) || / want [0-9a-f]{40}/.test(l));

test("the second clone fetches no object the mirror already held", async () => {
  const url = `file://${origin}`;
  const first = await cloneWithMirror({ dataDir: data(), repoId: "r1", url, dir: join(root, "c1"), env: {} });
  expect(first.ok).toBe(true);
  expect(existsSync(join(mirrorDir(data(), "r1"), "HEAD"))).toBe(true);

  const trace = join(root, "trace");
  const second = await cloneWithMirror({
    dataDir: data(), repoId: "r1", url, dir: join(root, "c2"),
    env: { GIT_TRACE_PACKET: trace },
  });
  expect(second.ok).toBe(true);
  // the mirror refresh asked for nothing new, and the clone wanted nothing
  expect(wants(trace)).toEqual([]);
  expect(readFileSync(join(root, "c2", "a.txt"), "utf8")).toBe("hello\n");
  // dissociated: no link left to the mirror
  expect(existsSync(join(root, "c2", ".git", "objects", "info", "alternates"))).toBe(false);
});

test("a deleted mirror still gives a good clone", async () => {
  const url = `file://${origin}`;
  expect((await mirrored(data(), "r2")).ok).toBe(true);
  const dir = join(root, "c3");
  const cloned = await cloneWithMirror({ dataDir: data(), repoId: "r2", url, dir, env: {} });
  expect(cloned.ok).toBe(true);
  rmSync(mirrorDir(data(), "r2"), { recursive: true, force: true });
  sh(["fsck", "--full"], dir);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello\n");
});

test("concurrent clones of one repository both succeed and share one mirror", async () => {
  const [a, b] = await Promise.all([mirrored(data(), "r3"), mirrored(data(), "r3")]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(existsSync(join(mirrorDir(data(), "r3"), "HEAD"))).toBe(true);
});

test("the borrowing clone runs inside the repository's lock", async () => {
  const s = slow(0.2);
  const clone = (dir: string) =>
    cloneWithMirror({ dataDir: data(), repoId: "r6", url: s.url, dir: join(root, dir), env: s.env });
  const [a, b] = await Promise.all([clone("locked-a"), clone("locked-b")]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  // Mirror build, clone, mirror fetch, clone: one at a time, never two at once.
  expect(s.log()).toEqual(["start", "end", "start", "end", "start", "end", "start", "end"]);
});

test("an agent's sandbox denies the mirrors", () => {
  const policy = sandboxPolicy({ dataDir: data(), agentName: "scout", urls: [] });
  expect(policy.denyRead).toContain(join(data(), "crew", ".mirrors"));
});

/** A clone of `repoId` that holds its lock for about a second. */
const cloningSlowly = (dataDir: string, repoId: string) => {
  const s = slow(0.5);
  let settled = false;
  const done = cloneWithMirror({ dataDir, repoId, url: s.url, dir: join(root, `slow-clone-${throwaway++}`), env: s.env });
  void done.finally(() => (settled = true));
  return { done, settled: () => settled };
};

test("deleting a repository deletes its mirror without waiting for a running clone", async () => {
  const dataDir = join(root, "forge");
  const app = createApp({ dataDir, port: 0 });
  try {
    const u = await signUp(app, { username: "carol", email: "carol@forge.test", password: "a-long-passphrase" });
    if (!u.ok) throw new Error("signup failed");
    promote(app.db, u.value);
    const made = await createRepo(app, u.value, { name: "gone" });
    if (!made.ok) throw new Error("repo failed");
    expect((await mirrored(dataDir, made.value.id)).ok).toBe(true);
    expect(existsSync(mirrorDir(dataDir, made.value.id))).toBe(true);
    const running = cloningSlowly(dataDir, made.value.id);
    await Bun.sleep(100);
    expect((await deleteRepo(app, u.value, made.value)).ok).toBe(true);
    // The delete did not wait for the clone holding the lock.
    expect(running.settled()).toBe(false);
    expect((await running.done).ok).toBe(true);
    for (let i = 0; i < 60 && existsSync(mirrorDir(dataDir, made.value.id)); i++) await Bun.sleep(50);
    expect(existsSync(mirrorDir(dataDir, made.value.id))).toBe(false);
  } finally {
    app.close();
  }
});

const gone = async (pid: number) => {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
};

test("aborting a running git ends it early and leaves no process behind", async () => {
  const pidFile = join(root, "pid");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const started = Date.now();
  const result = await runGit(
    ["clone", "--quiet", "--upload-pack", `echo $$ > ${pidFile}; exec cat #`, `file://${origin}`, join(root, "slow")],
    { timeoutMs: 60_000, signal: ctl.signal },
  );
  expect(result.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await gone(Number(readFileSync(pidFile, "utf8").trim()))).toBe(true);
});

test("an already aborted signal stops a clone that would succeed", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const dir = join(root, "aborted");
  const cloned = await cloneWithMirror({
    dataDir: data(), repoId: "r4", url: `file://${origin}`, dir, env: {}, signal: ctl.signal,
  });
  expect(cloned.ok).toBe(false);
  expect(existsSync(join(dir, "a.txt"))).toBe(false);
});

test("a cancelled clone keeps a good mirror", async () => {
  expect((await mirrored(data(), "r5")).ok).toBe(true);
  const ctl = new AbortController();
  ctl.abort();
  expect((await mirrored(data(), "r5", ctl.signal)).ok).toBe(false);
  expect(existsSync(join(mirrorDir(data(), "r5"), "HEAD"))).toBe(true);
});

test("removing an account deletes its repositories' mirrors without waiting for a running clone", async () => {
  const dataDir = join(root, "forge2");
  const app = createApp({ dataDir, port: 0 });
  try {
    const admin = await seedAdmin(app, { username: "boss", email: "boss@forge.test", password: "a-long-passphrase" });
    const dave = await signUp(app, { username: "dave", email: "dave@forge.test", password: "a-long-passphrase" });
    if (!admin.ok || !dave.ok) throw new Error("signup failed");
    promote(app.db, dave.value);
    const made = await createRepo(app, dave.value, { name: "mine" });
    if (!made.ok) throw new Error("repo failed");
    expect((await mirrored(dataDir, made.value.id)).ok).toBe(true);
    expect(existsSync(mirrorDir(dataDir, made.value.id))).toBe(true);
    const running = cloningSlowly(dataDir, made.value.id);
    await Bun.sleep(100);
    const removed = await removeAccount(app, admin.value, "dave");
    expect(removed.ok).toBe(true);
    expect(running.settled()).toBe(false);
    expect((await running.done).ok).toBe(true);
    for (let i = 0; i < 60 && existsSync(mirrorDir(dataDir, made.value.id)); i++) await Bun.sleep(50);
    expect(existsSync(mirrorDir(dataDir, made.value.id))).toBe(false);
  } finally {
    app.close();
  }
});
