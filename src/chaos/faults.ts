/**
 * The faults. Each takes a `World`, does its damage, then does what the
 * forge does to recover (reopen, sweep), and returns. The invariants are
 * asserted by the caller, never here.
 */

import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { sweepAbandonedChecks, failAbandonedRuns } from "../core/runs.ts";
import { serve } from "../http/server.ts";
import { takeSnapshot } from "../snapshot/snapshot.ts";
import { dirStore } from "../snapshot/store.ts";
import { dbFile, reopen, type World } from "./world.ts";

export interface Fault {
  readonly name: string;
  inject(world: World, rand: () => number): Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SIGKILL a process that is writing runs; boot again; sweep what it left. */
const killMidRun: Fault = {
  name: "kill the process mid-run",
  async inject(world, rand) {
    world.app.close();
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "worker.ts"), dbFile(world), world.repoId],
      { stdout: "pipe", stderr: "ignore", env: { PATH: process.env["PATH"] ?? "" } },
    );
    const seen: string[] = [];
    let buffer = "";
    const reader = child.stdout.getReader();
    const target = 3 + Math.floor(rand() * 40);
    while (seen.length < target) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line !== "ready") seen.push(line);
    }
    child.kill("SIGKILL");
    await child.exited;
    // Only ids the victim reported were committed; a line cut by the kill is dropped above.
    for (const id of seen) world.runIds.add(id);
    reopen(world);
    // What boot does: lapsed leases are swept, never left running.
    sweepAbandonedChecks(world.app.db, 0);
    failAbandonedRuns(world.app.db, 0);
  },
};

/** The connection goes away under the forge; the next boot finds all of it. */
const dropConnection: Fault = {
  name: "drop the SQLite connection",
  async inject(world) {
    world.app.db.close();
    let refused = false;
    try {
      world.app.db.query("SELECT 1").get();
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("a closed connection answered a query");
    reopen(world);
  },
};

/** The temp area refuses writes (a full disk's ENOSPC, close enough and safe). */
const fillTemp: Fault = {
  name: "fill the temp disk",
  async inject(world) {
    const scratch = mkdtempSync(join(tmpdir(), "forge-chaos-full-"));
    // A regular file where the directory should be: every mkdtemp under it fails.
    const blocker = join(scratch, "full");
    writeFileSync(blocker, "x");
    const before = process.env["TMPDIR"];
    process.env["TMPDIR"] = blocker;
    try {
      await takeSnapshot(
        {
          db: world.app.db,
          dataDir: world.dataDir,
          reposRoot: world.app.reposRoot,
          version: "chaos",
        },
        dirStore(join(scratch, "store")),
      ).then(
        () => {
          throw new Error("a snapshot succeeded with no temp space");
        },
        () => undefined,
      );
    } finally {
      if (before === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = before;
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};

/** A TCP proxy on loopback that holds every chunk back `delay` ms each way. */
export function slowProxy(port: number, delay: number) {
  type Side = { up?: Promise<Bun.Socket>; chain: Promise<void> };
  return Bun.listen<Side>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        // Each direction is a chain, so chunks keep their order and a close waits its turn.
        const side: Side = { chain: Promise.resolve() };
        client.data = side;
        side.up = Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            data(_up, bytes) {
              const copy = Buffer.from(bytes);
              side.chain = side.chain.then(async () => {
                await wait(delay);
                client.write(copy);
              });
            },
            close() {
              side.chain = side.chain.then(() => {
                client.end();
              });
            },
          },
        });
      },
      data(client, bytes) {
        const copy = Buffer.from(bytes);
        client.data.chain = client.data.chain.then(async () => {
          await wait(delay);
          (await client.data.up)?.write(copy);
        });
      },
      close(client) {
        void client.data.up?.then((up) => up.end());
      },
    },
  });
}

/** Every byte to the forge crawls through a delaying proxy; it still answers right. */
const slowLoopback: Fault = {
  name: "slow the loopback",
  async inject(world, rand) {
    const servers = await serve(world.app).catch((error: unknown) => {
      // A host that forbids the forge's own unix socket cannot run this fault.
      if (String(error).includes("EPERM")) return undefined;
      throw error;
    });
    if (servers === undefined) return;
    const delay = 5 + Math.floor(rand() * 20);
    const proxy = slowProxy(servers.port, delay);
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/healthz`, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`/healthz through a slow loopback said ${res.status}`);
    } finally {
      proxy.stop(true);
      servers.stop();
    }
  },
};

export const FAULTS: readonly Fault[] = [
  killMidRun,
  dropConnection,
  fillTemp,
  slowLoopback,
];
