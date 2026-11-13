/**
 * A real spawn, end to end (#7959), as `test/spawn-cell-e2e.test.ts` drives
 * it. Its own process, for the reason `real-child-forge.ts` is: a check sets
 * `FORGE_CELLS=off` for the forges its tests boot.
 *
 * A parent with the real server makes a child forge in a real cell from one
 * app, then asks `<app>--<child>--<parent>` through that server until the
 * app's own body comes back. Nothing is faked: not the cell, not the child's
 * runtime, not the route. Printed: one JSON line of what was seen.
 *
 * With the argument `recover` (test/spawn-small-cell.test.ts, #11981) it also
 * reads the child's cell limits, then stops the child as the host does for a
 * memory breach (a recorded stop and its process tree killed) and polls every
 * 100 ms until the app answers again, noting every status seen from the
 * first request on, so a 429 at any moment is reported.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../../src/actions/repos.ts";
import { spawnForge } from "../../src/actions/spawn.ts";
import { createApp } from "../../src/app.ts";
import { cellsAvailable, killTree } from "../../src/apps/contain.ts";
import { createUser, type User } from "../../src/core/users.ts";
import { repoDir } from "../../src/git/repos.ts";
import { commitFiles } from "../../src/git/write.ts";
import { serve } from "../../src/http/server.ts";
import { cellChildren, cellPlacement, stopCellChildren } from "../../src/spawn/cell.ts";
import { bootHostedChild } from "../../src/spawn/host.ts";
import { noteStop } from "../../src/spawn/stopped.ts";
import { memoryBodies } from "../../src/spawn/placement.ts";
import "./roomy-disk.ts";

// Two budgets, each its own: spawn+boot may take SPAWN_MS, then the poll gets
// POLL_MS counted from when boot ended. A slow spawn never shortens the poll,
// and a run that ran out says which phase did. The test's timeout is their sum
// plus slack (see test/spawn-cell-e2e.test.ts).
const SPAWN_MS = 120_000;
const POLL_MS = 60_000;
const RECOVER_MS = 60_000;
const recover = process.argv[2] === "recover";
// A killed run (the test's timeout sends SIGTERM) still stops its cell children.
let cleanup: () => Promise<void> = async () => {};
// The spawn and boot work, kept so a teardown after its budget ran out waits
// for it to settle (up to SETTLE_MS) before stopping cell children: a child it
// starts late is still stopped.
const SETTLE_MS = 15_000;
let pending: Promise<unknown> = Promise.resolve();
async function settled(): Promise<void> {
  await Promise.race([pending.catch(() => undefined), Bun.sleep(SETTLE_MS)]);
}
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(143)));
async function within<T>(ms: number, phase: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the ${phase} phase did not finish in ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

const cells = await cellsAvailable();
if (!cells.ok) {
  console.log(JSON.stringify({ skipped: cells.reason }));
  process.exit(0);
}

const BODY = "bakery says hi";
const dataDir = mkdtempSync(join(tmpdir(), "real-spawn-"));
mkdirSync(dataDir, { recursive: true });
const parent = createApp({ dataDir, url: "https://forge.test", port: 0 });
const servers = await serve(parent);
cleanup = async () => {
  servers.stop();
  await settled();
  await stopCellChildren(parent);
};

async function spawnAndBoot(alice: User) {
  const made = await spawnForge(
    parent,
    alice,
    { name: "kid", org: "kids", apps: ["alice/bakery"], carryBriefs: false, carrySubscriptions: false },
    { catalog: [{ ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 }], briefs: [], subscriptions: [] },
    {
      placement: cellPlacement(parent, memoryBodies(), () => 10),
      request: new Request("https://forge.test/x", { method: "POST", headers: { origin: "https://forge.test" } }),
      url: new URL("https://forge.test/x"),
    },
  );
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  await bootHostedChild(parent, "kid");
  return made;
}

try {
  const alice = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
  if (!alice.ok) throw new Error("user");
  const repo = await createRepo(parent, alice.value, { name: "bakery", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const committed = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
    branch: "main",
    message: "bakery",
    files: [
      { path: "forge.json", content: JSON.stringify({ app: { run: "bun run index.ts", health: "/" } }) },
      { path: "index.ts", content: `Bun.serve({ port: Number(process.env.PORT), fetch() { return new Response(${JSON.stringify(BODY)}) } })\n` },
    ],
    author: { name: "a", email: "a@x.invalid" },
  });
  if (!committed.ok) throw new Error("commit");
  const spawning = spawnAndBoot(alice.value);
  pending = spawning;
  const made = await within(SPAWN_MS, "spawn and boot", spawning);
  const seen = new Set<number>();
  // Asks the app's address until it answers 200 from the app, every `everyMs`; every status is
  // noted.
  async function pollApp(budgetMs: number, everyMs: number) {
    let last = { status: 0, body: "", app: null as string | null };
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      const res = await fetch(`${servers.url}/`, { headers: { host: "bakery--kid--forge.test" }, redirect: "manual" }).catch(() => undefined);
      if (res !== undefined) {
        last = { status: res.status, body: await res.text(), app: res.headers.get("x-forge-app") };
        seen.add(last.status);
        if (last.status === 200 && last.app === "bakery") break;
      }
      await Bun.sleep(everyMs);
    }
    return last;
  }
  const first = await pollApp(POLL_MS, recover ? 100 : 1000);
  let limits = null;
  let after = null;
  if (recover) {
    const held = cellChildren(parent).list()[0];
    limits = held?.limits ?? null;
    if (held !== undefined) {
      noteStop(parent, held.bodyId, "kid", "used 2374 MiB of memory, over its 2048 MiB limit", Date.now(), 1_000);
      killTree(held.pid);
      after = (await pollApp(RECOVER_MS, 100)).status;
    }
  }
  console.log(JSON.stringify({ placement: made.value.placement, status: first.status, body: first.body.slice(0, 200), app: first.app, ...(recover ? { limits, after, statuses: [...seen] } : {}) }));
} finally {
  await cleanup();
  parent.close();
  rmSync(dataDir, { recursive: true, force: true });
}
