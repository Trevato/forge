/**
 * `bun scripts/hollow.ts`, the command (#615): it says so and exits 0 on
 * this tree. Its own file, so its `bun test` process holds no audit of its
 * own: the child audits the whole tree, and two whole-tree audits in one
 * 512 MiB check runner were OOM-killed (exit 137) or swapped past the
 * timeout (check runs 859, 874, 883). `test/hollow.test.ts` holds the
 * audit's other tests.
 */

import { expect, test } from "bun:test";

const root = new URL("..", import.meta.url).pathname;
/** Reading the whole tree takes a second, and many on a busy machine. */
const WHOLE_TREE = 60_000;

test(
  "`bun scripts/hollow.ts` says so and exits 0",
  async () => {
    // Spawned, not spawnSync, so the timeout can still end a stuck child.
    const ran = Bun.spawn([process.execPath, "scripts/hollow.ts"], {
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(ran.stdout).text(),
      new Response(ran.stderr).text(),
      ran.exited,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toStartWith("hollow: none");
    expect(exitCode).toBe(0);
  },
  WHOLE_TREE,
);
