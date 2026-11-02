/**
 * Boot a restored data directory on a side port and read its health, the
 * way `docs/RECOVERY.md` does by hand. The child gets a clean environment:
 * the directory, a free port, no SSH listener, and `FORGE_APP_ENV=preview`
 * so the crew stays off a copy of production's queue. It is killed whatever
 * the answer.
 */

import { join } from "node:path";
import { lostPort, onFreshPort } from "../kernel/port.ts";

export interface Booted {
  readonly ok: boolean;
  /** Why not, for the person reading; never a value. */
  readonly reason: string;
}

const TREE = join(import.meta.dir, "../..");

export async function bootRestored(
  dataDir: string,
  budgetMs: number,
  tree: string = TREE,
): Promise<Booted> {
  return onFreshPort((port) => bootOnPort(dataDir, budgetMs, port, tree));
}

async function bootOnPort(
  dataDir: string,
  budgetMs: number,
  port: number,
  tree: string,
): Promise<{ result: Booted; portLost: boolean }> {
  const child = Bun.spawn([process.execPath, join(tree, "src/main.ts")], {
    cwd: tree,
    env: {
      PATH: process.env["PATH"] ?? "",
      FORGE_DATA: dataDir,
      PORT: String(port),
      FORGE_SSH_PORT: "0",
      FORGE_APP_ENV: "preview",
      // Only a test host sets this: its internal door is a port, not a socket.
      ...(process.env["FORGE_TEST_SOCKET"]
        ? { FORGE_TEST_SOCKET: process.env["FORGE_TEST_SOCKET"] }
        : {}),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let stderr = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-8_192);
  })().catch(() => undefined);
  const no = (reason: string, portLost = false) => ({ result: { ok: false, reason }, portLost });
  const until = performance.now() + Math.min(budgetMs, 60_000);
  let last = "no answer";
  try {
    while (performance.now() < until) {
      if (child.exitCode !== null) {
        await reading;
        return no(`the restored forge exited with ${child.exitCode}`, lostPort(stderr));
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
        if (res.ok && body?.ok === true) return { result: { ok: true, reason: "" }, portLost: false };
        last = `health answered ${res.status}${body?.ok === false ? " not ok" : ""}`;
      } catch {
        last = "no answer yet";
      }
      await Bun.sleep(200);
    }
    return no(`the restored forge never read healthy: ${last}`);
  } finally {
    child.kill();
    await child.exited;
  }
}
