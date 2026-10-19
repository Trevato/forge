/**
 * A restore says where it is (#2616): the drill that timed out at ten
 * minutes could not tell fetching from unpacking from cloning.
 */

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../src/kernel/result.ts";
import { restoreSnapshot, type Progress } from "../src/snapshot/restore.ts";
import type { Store } from "../src/snapshot/store.ts";

const NAME = "2026-10-19T08-00-00Z";
const prefix = `snapshots/${NAME}/`;

function memory(objects: Map<string, Uint8Array>): Store {
  return {
    where: "memory",
    get: async (path: string) => objects.get(path),
  } as unknown as Store;
}

test("progress runs through the phases with done rising to total and bytes adding up", async () => {
  const objects = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const paths = ["a.txt", "b.txt", "c.txt", "repos/u/one.bundle", "repos/u/two.bundle"];
  const files = paths.map((path, n) => {
    const body = enc.encode("x".repeat(10 * (n + 1)));
    objects.set(prefix + path, body);
    return { path, bytes: body.byteLength };
  });
  objects.set(
    `${prefix}manifest.json`,
    enc.encode(
      JSON.stringify({ name: NAME, startedAt: "t", finishedAt: "t", version: "t", repos: 2, apps: 0, files, bytes: 150, key: "raw" }),
    ),
  );
  const root = mkdtempSync(join(tmpdir(), "forge-restore-progress-"));
  const seen: Progress[] = [];
  const git = (async () => ok("")) as unknown as typeof import("../src/git/env.ts").runGit;
  try {
    await restoreSnapshot(memory(objects), NAME, join(root, "data"), {
      git,
      onProgress: (p) => seen.push(p),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const order = [...new Set(seen.map((p) => p.phase))];
  expect(order).toEqual(["manifest", "files", "unpack", "bundles", "key"]);
  const of = (phase: string) => seen.filter((p) => p.phase === phase);
  expect(of("files").map((p) => p.done)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(of("files").every((p) => p.total === 5)).toBe(true);
  expect(of("files").at(-1)!.bytes).toBe(files.reduce((s, f) => s + f.bytes, 0));
  expect(of("bundles").map((p) => p.done)).toEqual([0, 1, 2]);
  expect(of("bundles").at(-1)).toEqual({ phase: "bundles", done: 2, total: 2, bytes: 40 + 50 });
  expect(of("unpack")).toEqual([{ phase: "unpack", done: 0, total: 0, bytes: 0 }]);
  expect(of("key")).toEqual([{ phase: "key", done: 0, total: 0, bytes: 0 }]);
});
