/**
 * A roll never cuts an in-flight push (#2040). Two forges on one data
 * directory share the port (SO_REUSEPORT), as during a release swap: a push
 * that started on the old one trickles in for thirty seconds while the new
 * one comes up and the old one drains. The old stops accepting at drain
 * start — new connections are the new forge's — and answers the push to the
 * end before it goes.
 */

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { drainOnHandover, handover } from "../src/release/swap.ts";
import { serve } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const PUSH_MS = 30_000;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// Without it, what sat in the old listener's accept queue is reset when it
// closes — at drain start now, at the end before; either way the kernel's.
const migrates = (() => {
  try {
    return readFileSync("/proc/sys/net/ipv4/tcp_migrate_req", "utf8").trim() === "1";
  } catch {
    return false;
  }
})();

async function git(args: string[], cwd: string, stdin?: string): Promise<Uint8Array> {
  const out = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitClientEnv(),
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  return new Uint8Array(out.stdout);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();

function pktLine(line: string): Uint8Array {
  const body = new TextEncoder().encode(line);
  const head = (body.length + 4).toString(16).padStart(4, "0");
  return new Uint8Array([...new TextEncoder().encode(head), ...body]);
}

/** `bytes` sent in pieces spread over `ms`, so the request stays in flight that long. */
function trickle(bytes: Uint8Array, ms: number): ReadableStream<Uint8Array> {
  const pieces = 30;
  const size = Math.ceil(bytes.length / pieces);
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i > 0) await Bun.sleep(ms / pieces);
      const piece = bytes.subarray(i * size, (i + 1) * size);
      i++;
      if (piece.length > 0) controller.enqueue(piece);
      if (i >= pieces) controller.close();
    },
  });
}

/**
 * The old forge on a port of its own, alice's repository, and `push(ms)`: a
 * receive-pack of one new commit on main, trickled in over `ms`.
 */
async function forgeWithPush() {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-handover-"));
  const work = await mkdtemp(join(tmpdir(), "forge-handover-work-"));
  dirs.push(dataDir, work);
  // The old forge picks the port; the release binds the one it got.
  const oldApp = createApp({ dataDir, port: 0, selfSwap: true });
  const oldServers = await serve(oldApp);
  const port = oldServers.port;
  const made = await createUser(oldApp.db, {
    trusted: true,
    username: "alice",
    email: "a@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error("user");
  const alice = made.value;
  const repo = await createRepo(oldApp, alice, { name: "garden", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  await commitToBranch(oldApp, alice, repo.value, {
    message: "seed",
    files: [{ path: "a.txt", content: "a" }],
  });
  const { token } = createToken(oldApp.db, alice.id, "push", "rw");

  // The push: one commit on main, as git sends it to receive-pack.
  const bare = repoDir(oldApp.reposRoot, "alice", "garden");
  const clone = join(work, "garden");
  await git(["clone", "-q", bare, clone], work);
  await Bun.write(join(clone, "b.txt"), "b");
  await git(["add", "b.txt"], clone);
  await git(["commit", "-q", "-m", "b"], clone);
  const before = text(await git(["rev-parse", "origin/main"], clone));
  const after = text(await git(["rev-parse", "HEAD"], clone));
  const pack = await git(
    ["pack-objects", "--stdout", "--revs", "--quiet"],
    clone,
    `${after}\n^${before}\n`,
  );
  const command = pktLine(`${before} ${after} refs/heads/main\0report-status\n`);
  const flush = new TextEncoder().encode("0000");
  const body = new Uint8Array(command.length + flush.length + pack.length);
  body.set(command, 0);
  body.set(flush, command.length);
  body.set(pack, command.length + flush.length);

  const url = `http://127.0.0.1:${port}`;
  const push = (ms: number) =>
    fetch(`${url}/alice/garden.git/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`alice:${token}`)}`,
        "content-type": "application/x-git-receive-pack-request",
      },
      body: trickle(body, ms),
    });
  return { oldApp, oldServers, port, url, bare, after, push };
}

test("a push in flight on the old forge completes across the roll, and no connection is refused", async () => {
  const { oldApp, oldServers, port, url, bare, after, push: pushOver } = await forgeWithPush();
  const dataDir = oldApp.config.dataDir;
  const started = Date.now();
  const push = pushOver(PUSH_MS);
  // The push is the old forge's before the release exists.
  await Bun.sleep(500);

  const newApp = createApp({ dataDir, port, selfSwap: true });
  const newServers = await serve(newApp);

  let looping = true;
  let asked = 0;
  let refused = 0;
  const client = (async () => {
    while (looping) {
      asked++;
      try {
        const res = await fetch(`${url}/api/v1/health`, {
          headers: { connection: "close" },
          signal: AbortSignal.timeout(3_000),
        });
        await res.arrayBuffer();
      } catch {
        refused++;
      }
      await Bun.sleep(20);
    }
  })();

  // Drain start: the old forge stops listening, keeping what it holds.
  const drained = oldServers.stopAccepting(PUSH_MS * 2);

  const answer = await push;
  const report = await answer.text();
  expect(answer.status).toBe(200);
  expect(report).toContain("unpack ok");
  expect(report).toContain("ok refs/heads/main");
  expect(Date.now() - started).toBeGreaterThanOrEqual(PUSH_MS * 0.9);
  await drained;

  looping = false;
  await client;
  expect(asked).toBeGreaterThan(100);
  if (migrates) expect(refused).toBe(0);
  expect(text(await git(["rev-parse", "refs/heads/main"], bare))).toBe(after);

  // Nobody else listens: the old forge let go of the port at drain start.
  // `stop` closes the listener asynchronously, so ask until it is gone.
  newServers.stop();
  let orphan = "answered";
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    orphan = await fetch(`${url}/api/v1/health`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(2_000),
    }).then(
      async (res) => {
        await res.arrayBuffer();
        return "answered";
      },
      () => "refused",
    );
    if (orphan === "refused") break;
    await Bun.sleep(100);
  }
  expect(orphan).toBe("refused");

  oldServers.stop();
  newApp.close();
  oldApp.close();
}, PUSH_MS * 3);

test("handover.drain lets go of the port before the rest of the drain, and closes only after the push is answered", async () => {
  const { oldApp, oldServers, url, bare, after, push: pushOver } = await forgeWithPush();
  const HELD_MS = 4_000;
  const REST_MS = 2_000;
  const push = pushOver(HELD_MS).then(async (res) => {
    const report = await res.text();
    answeredAt = Date.now();
    return { status: res.status, report };
  });
  let answeredAt = 0;
  let restDoneAt = 0;
  let closedAt = 0;
  // Wired as `main.ts` wires it; `rest` stands in for the shutdown's other
  // steps (crew, apps, checks), `close` for its last.
  const handOver = drainOnHandover(
    oldServers,
    async () => {
      await Bun.sleep(REST_MS);
      restDoneAt = Date.now();
    },
    () => {
      closedAt = Date.now();
      oldServers.stop();
    },
  );
  handover.drain = () => void handOver();
  try {
    await Bun.sleep(500);
    handover.drain();

    // Nobody else listens here, so a refused connection is this listener gone.
    let refusedAt = 0;
    while (restDoneAt === 0) {
      const gone = await fetch(`${url}/api/v1/health`, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(1_000),
      }).then(
        async (res) => {
          await res.arrayBuffer();
          return false;
        },
        () => true,
      );
      if (gone) {
        refusedAt = Date.now();
        break;
      }
      await Bun.sleep(50);
    }
    expect(refusedAt).toBeGreaterThan(0);
    expect(restDoneAt).toBe(0);

    const answered = await push;
    expect(answered.status).toBe(200);
    expect(answered.report).toContain("ok refs/heads/main");
    while (closedAt === 0) await Bun.sleep(50);
    // The push answered in full (200, "ok refs/heads/main") is the proof the
    // close waited for it: the client stamps `answeredAt` after reading the
    // body, which can trail the server's close by a millisecond.
    expect(answeredAt).toBeGreaterThan(0);
    expect(closedAt).toBeGreaterThanOrEqual(restDoneAt);
    expect(text(await git(["rev-parse", "refs/heads/main"], bare))).toBe(after);
  } finally {
    delete handover.drain;
    oldServers.stop();
    oldApp.close();
  }
}, 30_000);
