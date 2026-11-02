/**
 * A pod restart comes back on the newest good swapped tree (#8042). The image
 * is a base: while the same image restarts, the swapped release kept over it
 * runs first, and an older image's version never overwrites it. A different
 * image (a deliberate roll) is the newer base; a swapped tree that will not
 * start gives way to the image, and the forge says so.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { keepGood, lastGood, launch, rolledBack, type Launched } from "../src/release/launch.ts";
import { clearServing, follow, readServing, writeServing } from "../src/release/serving.ts";

let root: string;
let n = 0;
const running: Subprocess[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-swapped-launch-"));
});
afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tree(main: string): string {
  const dir = join(root, `tree-${++n}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), main);
  writeFileSync(join(dir, "package.json"), "{}");
  return dir;
}
const SERVES = `
Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(req) {
  if (new URL(req.url).pathname !== "/api/v1/health") return new Response("", { status: 404 });
  return Response.json({ ok: true, version: process.env.FORGE_VERSION, commit: process.env.FORGE_COMMIT || null, base: process.env.FORGE_BASE_VERSION });
} });
`;
const THROWS = `throw new Error("(test fixture) the swapped tree does not start");\n`;

async function run(dataDir: string, dir: string, version: string, graceMs = 30_000): Promise<Launched & { port: number }> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  const launched = await launch({
    tree: dir,
    dataDir,
    port,
    version,
    commit: null,
    env: { PATH: process.env.PATH, PORT: String(port) },
    graceMs,
    started: (child) => running.push(child),
  });
  return { ...launched, port };
}

const healthAt = async (port: number) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as { version: string; commit: string; base: string };

const SWAPPED = "5".repeat(40);

test("the same image restarting runs the swapped release kept over it, and keeps it", async () => {
  const data = join(root, "data-same");
  keepGood(data, tree(SERVES), "0.7.290", SWAPPED, Date.now(), "0.7.283");
  expect(lastGood(data)).toMatchObject({ version: "0.7.290", commit: SWAPPED, base: "0.7.283" });
  // The image is the older 0.7.283; its tree throws, so only the swapped tree can answer.
  const launched = await run(data, tree(THROWS), "0.7.283");
  expect(launched.ran).toBe("release");
  expect(await healthAt(launched.port)).toMatchObject({ version: "0.7.290", commit: SWAPPED, base: "0.7.283" });
  expect(lastGood(data)).toMatchObject({ version: "0.7.290", base: "0.7.283" });
  expect(rolledBack(data)).toBeUndefined();
});

test("a stale image that is ready does not replace the swapped release as the last good one", async () => {
  const data = join(root, "data-stale");
  keepGood(data, tree(SERVES), "0.7.290", SWAPPED, Date.now(), "0.7.283");
  await run(data, tree(SERVES), "0.7.283");
  expect(lastGood(data)?.version).toBe("0.7.290");
});

test("a different image is a deliberate roll: it runs, and is kept over the swapped tree", async () => {
  const data = join(root, "data-newer");
  keepGood(data, tree(SERVES), "0.7.290", SWAPPED, Date.now(), "0.7.283");
  const launched = await run(data, tree(SERVES), "0.7.300");
  expect(launched.ran).toBe("release");
  expect(await healthAt(launched.port)).toMatchObject({ version: "0.7.300" });
  expect(lastGood(data)).toMatchObject({ version: "0.7.300", base: null });
});

test("a swapped tree that does not start gives way to the image, recorded as a rollback", async () => {
  const data = join(root, "data-broken");
  keepGood(data, tree(THROWS), "0.7.290", SWAPPED, Date.now(), "0.7.283");
  const launched = await run(data, tree(SERVES), "0.7.283");
  expect(launched.ran).toBe("rollback");
  expect(launched.line).toContain("0.7.290: it exited with 1 before it was ready; the image 0.7.283 runs instead");
  expect(await healthAt(launched.port)).toMatchObject({ version: "0.7.283" });
  expect(rolledBack(data)).toMatchObject({ from: "0.7.290", to: "0.7.283", paged: false });
});

test("the launcher follows the process that took over, and lets go when it is gone", async () => {
  const data = join(root, "data-follow");
  clearServing(data);
  expect(readServing(data)).toBeUndefined();
  const heir = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 700)"], { stdout: "ignore", stderr: "ignore" });
  writeServing(data, { pid: heir.pid, sha: SWAPPED });
  expect(readServing(data)).toEqual({ pid: heir.pid, sha: SWAPPED });
  const began = Date.now();
  await follow(data, 1, 50);
  expect(Date.now() - began).toBeGreaterThanOrEqual(400);
  await heir.exited;
  // Its own child serving again (or nobody) ends the wait at once.
  writeServing(data, { pid: 4242, sha: SWAPPED });
  const own = Date.now();
  await follow(data, 4242, 50);
  expect(Date.now() - own).toBeLessThan(200);
  clearServing(data);
  expect(readServing(data)).toBeUndefined();
});
