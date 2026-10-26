/**
 * Big repositories always clone (#4482). A fetch ends once it stops moving,
 * not on a wall clock, so a large pack over a slow link finishes while a
 * client that stops reading is still cut off. Upload-pack serves partial
 * clones, so `git clone --filter=blob:none` skips the big blobs and a later
 * checkout fetches them. A fetch by object id passes the same read check as
 * a clone.
 *
 * Time is scaled down. The real window is 30 s and a CAD repository is
 * hundreds of megabytes; here the window is one second and the pack is 4 MiB
 * through a 1 MiB/s link, so the clone lasts several windows, longer than
 * the wall clock it is also run against.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { runGit } from "../src/git/env.ts";
import { metered, watchProgress, type Stall } from "../src/git/progress.ts";
import { initBareRepo, repoDir } from "../src/git/repos.ts";
import {
  advertiseRefs,
  isGitService,
  serviceRpc,
  type SmartHttpOptions,
} from "../src/git/smart-http.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { unwrap } from "../src/kernel/result.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

/**
 * One git client run. A clone expected to succeed is matched whole
 * (`toMatchObject({ code: 0 })`), so a red prints git's stderr, not a bare 128.
 */
interface Run {
  code: number;
  out: string;
  err: string;
}

async function git(args: string[], cwd: string): Promise<Run> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(),
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

async function ok(args: string[], cwd: string): Promise<string> {
  const run = await git(args, cwd);
  if (run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.err}`);
  return run.out;
}

/** Object ids a partial clone does not have, without fetching them. */
async function missing(dir: string): Promise<string[]> {
  const out = await ok(["rev-list", "--objects", "--missing=print", "--all"], dir);
  return out
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1));
}

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += 65_536)
    crypto.getRandomValues(out.subarray(at, Math.min(size, at + 65_536)));
  return out;
}

describe("watchProgress", () => {
  const stall: Stall = { windowMs: 300, minBytes: 1_000 };

  test("a transfer that keeps moving is never killed", async () => {
    let killed = false;
    const progress = watchProgress(stall, 60_000, () => (killed = true));
    const feed = setInterval(() => progress.moved(400), 50);
    await Bun.sleep(1_200);
    clearInterval(feed);
    progress.stop();
    expect(killed).toBe(false);
  });

  test("a transfer that stalls is killed within a window and a slice", async () => {
    let killedAt = 0;
    const start = Date.now();
    const progress = watchProgress(stall, 60_000, () => (killedAt = Date.now()));
    // A trickle under the floor is a stall too.
    const feed = setInterval(() => progress.moved(10), 50);
    await Bun.sleep(1_000);
    clearInterval(feed);
    progress.stop();
    expect(killedAt).toBeGreaterThan(0);
    expect(killedAt - start).toBeGreaterThanOrEqual(stall.windowMs - 20);
    expect(killedAt - start).toBeLessThan(stall.windowMs * 2 + 200);
  });

  test("the cap ends a transfer however well it moves", async () => {
    let killed = false;
    const progress = watchProgress(stall, 400, () => (killed = true));
    const feed = setInterval(() => progress.moved(10_000), 50);
    await Bun.sleep(700);
    clearInterval(feed);
    progress.stop();
    expect(killed).toBe(true);
  });

  test("git's keep-alive counts as progress; other bytes count as themselves", async () => {
    let moved = 0;
    const progress = { moved: (n: number) => (moved += n), stop: () => {} };
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x30, 0x30, 0x30, 0x35, 0x01]));
        controller.enqueue(new TextEncoder().encode("0006\x01a"));
        controller.close();
      },
    });
    const out = await new Response(metered(source, progress, stall).stream).arrayBuffer();
    expect(out.byteLength).toBe(11);
    expect(moved).toBe(stall.minBytes + 11);
  });
});

/** Delays each chunk as a link of `bytesPerSecond` would. */
function throttled(
  body: ReadableStream<Uint8Array>,
  bytesPerSecond: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        await Bun.sleep((value.length * 1_000) / bytesPerSecond);
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/**
 * Passes `after` bytes on, then stops reading for `pauseMs`, like a client
 * that went away, and reads on after it. A transfer still alive then
 * finishes; one that was ended hands back a cut-off pack.
 */
function pausing(
  body: ReadableStream<Uint8Array>,
  after: number,
  pauseMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let passed = 0;
  let paused = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (passed >= after && !paused) {
          paused = true;
          await Bun.sleep(pauseMs);
        }
        const { done, value } = await reader.read();
        if (done) return controller.close();
        passed += value.length;
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/**
 * What a test that is not about stalls serves with: the verdict is the
 * clone's, never the check machine's speed. A loaded machine that takes
 * longer than a default window to start a pack is slow, not stalled.
 */
const PATIENT: SmartHttpOptions = {
  stall: { windowMs: 120_000, minBytes: 1 },
  timeoutMs: 300_000,
  idleMs: 120_000,
};

describe("a big repository over smart http", () => {
  const stall: Stall = { windowMs: 1_000, minBytes: 16 * 1024 };
  const BIG = 4 * 1024 * 1024;
  let root: string;
  let work: string;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let big: Uint8Array;
  /** How this test's fetch is answered: its options and its link. */
  let fetchOptions: SmartHttpOptions = PATIENT;
  let link = (body: ReadableStream<Uint8Array>) => body;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-bigclone-"));
    work = await mkdtemp(join(tmpdir(), "forge-bigclone-work-"));
    const bare = repoDir(root, "ada", "arm");
    unwrap(await initBareRepo(bare));
    const seed = join(work, "seed");
    await ok(["init", "-q", "-b", "main", seed], work);
    big = randomBytes(BIG);
    await Bun.write(join(seed, "base.step"), big);
    await Bun.write(join(seed, "README.md"), "# arm\n");
    await ok(["add", "."], seed);
    await ok(["commit", "-q", "-m", "cad"], seed);
    await ok(["push", "-q", bare, "main"], seed);

    server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const dir = repoDir(root, "ada", "arm");
        if (url.pathname === "/ada/arm.git/info/refs") {
          const service = url.searchParams.get("service");
          if (!isGitService(service)) return new Response("no", { status: 400 });
          return advertiseRefs(dir, service, request);
        }
        if (url.pathname === "/ada/arm.git/git-upload-pack") {
          const response = await serviceRpc(dir, "git-upload-pack", request, fetchOptions);
          return new Response(link(response.body!), { headers: response.headers });
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}/ada/arm.git`;
  });

  afterAll(async () => {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("a clone through a 1 MiB/s link outlasts several windows and finishes", async () => {
    fetchOptions = { stall, timeoutMs: 60_000 };
    link = (body) => throttled(body, 1024 * 1024);
    try {
      const start = Date.now();
      const run = await git(["clone", "-q", base, "slow"], work);
      expect(run.err).toBe("");
      expect(run.code).toBe(0);
      expect(Date.now() - start).toBeGreaterThan(stall.windowMs * 3);
      const got = new Uint8Array(await Bun.file(join(work, "slow", "base.step")).arrayBuffer());
      expect(got.length).toBe(BIG);
      expect(Bun.hash(got)).toBe(Bun.hash(big));
    } finally {
      fetchOptions = PATIENT;
      link = (body) => body;
    }
  }, 60_000);

  test("the same clone under a wall clock is cut off: the clock was the bug", async () => {
    fetchOptions = { stall, timeoutMs: 2_000 };
    link = (body) => throttled(body, 1024 * 1024);
    try {
      const run = await git(["clone", "-q", base, "clocked"], work);
      expect(run.code).not.toBe(0);
    } finally {
      fetchOptions = PATIENT;
      link = (body) => body;
    }
  }, 60_000);

  test("a client that stops reading for longer than a window is cut off", async () => {
    fetchOptions = { stall, timeoutMs: 60_000 };
    link = (body) => pausing(body, 64 * 1024, stall.windowMs * 3);
    try {
      const run = await git(["clone", "-q", base, "stalled"], work);
      expect(run.code).not.toBe(0);
      expect(run.err).toContain("early EOF");
    } finally {
      fetchOptions = PATIENT;
      link = (body) => body;
    }
  }, 60_000);

  test("a pause shorter than a window is not a stall", async () => {
    fetchOptions = { stall, timeoutMs: 60_000 };
    link = (body) => pausing(body, 64 * 1024, stall.windowMs / 3);
    try {
      const run = await git(["clone", "-q", base, "paused"], work);
      expect(run).toMatchObject({ code: 0 });
    } finally {
      fetchOptions = PATIENT;
      link = (body) => body;
    }
  }, 60_000);

  for (const version of [0, 2]) {
    test(`--filter=blob:limit=1m over protocol v${version} leaves the big blob behind, and checkout fetches it`, async () => {
      const dir = `limit-v${version}`;
      const run = await git(
        ["-c", `protocol.version=${version}`, "clone", "-q", "--no-checkout", "--filter=blob:limit=1m", base, dir],
        work,
      );
      expect(run.err).not.toContain("filtering not recognized");
      expect(run).toMatchObject({ code: 0 });
      const clone = join(work, dir);
      const bigOid = await ok(["rev-parse", "HEAD:base.step"], clone);
      const readmeOid = await ok(["rev-parse", "HEAD:README.md"], clone);
      const absent = await missing(clone);
      expect(absent).toContain(bigOid);
      expect(absent).not.toContain(readmeOid);

      await ok(["-c", `protocol.version=${version}`, "reset", "-q", "--hard", "HEAD"], clone);
      expect(await missing(clone)).toEqual([]);
      const got = new Uint8Array(await Bun.file(join(clone, "base.step")).arrayBuffer());
      expect(Bun.hash(got)).toBe(Bun.hash(big));
    }, 180_000);

    test(`--filter=blob:none over protocol v${version} clones and checks out`, async () => {
      const dir = `none-v${version}`;
      const run = await git(
        ["-c", `protocol.version=${version}`, "clone", "-q", "--filter=blob:none", base, dir],
        work,
      );
      expect(run.err).not.toContain("filtering not recognized");
      expect(run).toMatchObject({ code: 0 });
      expect(await Bun.file(join(work, dir, "README.md")).text()).toBe("# arm\n");
      expect((await Bun.file(join(work, dir, "base.step")).arrayBuffer()).byteLength).toBe(BIG);
    }, 180_000);
  }
});

describe("a fetch by object id is a read like any other", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let token: string;
  let secretOid: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-bigclone-app-"));
    work = await mkdtemp(join(tmpdir(), "forge-bigclone-app-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const owner = await seedAdmin(app, {
      username: "ada",
      email: "ada@f.dev",
      password: "owner-passphrase",
    });
    if (!owner.ok) throw new Error(owner.error);
    token = createToken(app.db, owner.value.id, "t", "ro").token;
    const vault = await createRepo(app, owner.value, { name: "vault" });
    const open = await createRepo(app, owner.value, { name: "open", visibility: "public" });
    if (!vault.ok || !open.ok) throw new Error("repo creation failed");
    await commitToBranch(app, owner.value, vault.value, {
      message: "seed",
      files: [{ path: "secret", content: "the vault's secret\n" }],
    });
    await commitToBranch(app, owner.value, open.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# open\n" }],
    });
    secretOid = unwrap(
      await runGit(["rev-parse", "main:secret"], { cwd: repoDir(app.reposRoot, "ada", "vault") }),
    );
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  const url = (name: string, auth = ""): string =>
    `${servers.url.replace("://", `://${auth}`)}/ada/${name}.git`;

  test("a stranger cannot fetch a private repository's blob by its id", async () => {
    const dir = join(work, "stranger");
    await ok(["init", "-q", dir], work);
    for (const version of [0, 2]) {
      const run = await git(["-c", `protocol.version=${version}`, "fetch", url("vault"), secretOid], dir);
      expect(run.code).not.toBe(0);
    }
    const lookup = await git(["cat-file", "-e", secretOid], dir);
    expect(lookup.code).not.toBe(0);
  });

  test("a partial clone of a public repository cannot reach into a private one", async () => {
    const run = await git(["clone", "-q", "--filter=blob:none", url("open"), "open"], work);
    expect(run.code).toBe(0);
    const lazy = await git(["cat-file", "-p", secretOid], join(work, "open"));
    expect(lazy.code).not.toBe(0);
    expect(lazy.out).not.toContain("secret");
  });

  test("a reader's partial clone of the private repository fetches the blob lazily", async () => {
    const dir = join(work, "reader");
    const auth = `ada:${token}@`;
    const run = await git(["clone", "-q", "--no-checkout", "--filter=blob:none", url("vault", auth), dir], work);
    expect(run.code).toBe(0);
    expect(await missing(dir)).toContain(secretOid);
    expect(await ok(["cat-file", "-p", secretOid], dir)).toBe("the vault's secret");
  });
});
