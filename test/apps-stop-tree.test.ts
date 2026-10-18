/**
 * An app that runs as a plain child (no cell: the host cannot hold one)
 * leads its own process group, so what it started ends with it: a stop
 * asks every process in the group, and once the app is gone — stopped or
 * crashed — whatever is left of the group is killed. Before this, a stop
 * signalled the app's pid alone and its children lived on, re-parented,
 * holding the environment's data and token after the forge called it gone.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppManifest } from "../src/apps/manifest.ts";
import { startProcess, type ProcessHandle } from "../src/apps/process.ts";

const manifest: AppManifest = {
  run: "",
  install: null,
  test: null,
  health: "/",
  ready: 10,
  tty: null,
  service: null,
  looks: ["/"],
};

/** A server that starts `child` and writes its pid to `child.pid` before it answers. */
const server = (child: readonly string[], onTerm: "exit" | "default") =>
  `const child = Bun.spawn(${JSON.stringify(child)}, { stdio: ["ignore", "ignore", "ignore"] });
await Bun.write("child.pid", String(child.pid));
${onTerm === "exit" ? `process.on("SIGTERM", () => process.exit(0));` : ""}
Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("ok") });
`;

/** Alive and not a zombie a parent has yet to reap. */
function alive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  // The state follows the command name, which is in parentheses.
  const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
  return state !== "Z" && state !== "X";
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

async function withApp(
  source: string,
  body: (handle: ProcessHandle, childPid: number) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forge-stop-tree-"));
  let childPid: number | undefined;
  try {
    await writeFile(join(dir, "server.ts"), source);
    const started = await startProcess({
      dir,
      dataDir: dir,
      manifest: { ...manifest, run: `${process.execPath} server.ts` },
      env: "production",
      url: "http://app.test",
      commitOid: "0".repeat(40),
      forgeUrl: "http://forge.test",
      identityKey: "key",
      log: () => {},
      signal: new AbortController().signal,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    childPid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    expect(alive(childPid)).toBe(true);
    await body(started.value.handle, childPid);
  } finally {
    // A red run must not leave its sleeper behind on the machine.
    if (childPid !== undefined && alive(childPid))
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // gone after all
      }
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "linux")(
  "apps: an uncelled app's process tree ends with it",
  () => {
    test("stop ends the children the app started, not just the app", async () => {
      await withApp(server(["sleep", "300"], "default"), async (handle, child) => {
        await handle.stop();
        expect(await goneWithin(child, 3_000)).toBe(true);
      });
    }, 30_000);

    test("a child that ignores SIGTERM is killed once the app has gone", async () => {
      await withApp(
        server(["sh", "-c", "trap '' TERM; exec sleep 300"], "exit"),
        async (handle, child) => {
          await handle.stop();
          expect(await goneWithin(child, 3_000)).toBe(true);
        },
      );
    }, 30_000);

    test("an app that exits on its own takes its children with it", async () => {
      await withApp(server(["sleep", "300"], "default"), async (handle, child) => {
        process.kill(handle.pid, "SIGKILL");
        await handle.exited;
        expect(await goneWithin(child, 3_000)).toBe(true);
      });
    }, 30_000);
  },
);
