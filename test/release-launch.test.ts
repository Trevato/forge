/**
 * A roll to a version that never becomes ready undoes itself (#2652): the
 * image's launcher (`src/release/launch.ts`) starts its forge, and when that
 * forge exits or is not ready within the grace, it starts the last version
 * that was, from the tree kept on the volume, and records the rollback for
 * the forge to show and page once.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  keepGood,
  lastGood,
  launch,
  markRollbackPaged,
  READY_GRACE_MS,
  rollbackNeed,
  rolledBack,
  type Launched,
} from "../src/release/launch.ts";

let root: string;
let n = 0;
const running: Subprocess[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-release-launch-"));
});
const reap = async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
};
afterEach(reap);
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
  return Response.json({ ok: true, version: process.env.FORGE_VERSION, commit: process.env.FORGE_COMMIT || null });
} });
`;
const THROWS = `throw new Error("(test fixture) a release whose main throws at import, as 0.7.166's did");\n`;
const HANGS = `setInterval(() => {}, 1_000);\n`;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

async function run(dataDir: string, dir: string, version: string, graceMs = 30_000): Promise<Launched & { port: number }> {
  const port = await freePort();
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

async function healthAt(port: number): Promise<{ version: string; commit: string | null } | undefined> {
  for (let i = 0; i < 100; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as { version: string; commit: string | null };
    } catch {
      await Bun.sleep(100);
    }
  }
  return undefined;
}

test("a version that reads ready is kept as the last good release", async () => {
  const data = join(root, "data-ready");
  expect((await run(data, tree(SERVES), "0.7.162")).ran).toBe("release");
  expect(lastGood(data)).toMatchObject({ version: "0.7.162" });
  expect(existsSync(join(data, "release", "good", "0.7.162", "src", "main.ts"))).toBe(true);
  expect(existsSync(join(data, "release", "good", "0.7.162", "package.json"))).toBe(true);
});

test("a version whose main throws at import is undone at once: the last good one serves under its own stamp", async () => {
  const data = join(root, "data-throws");
  keepGood(data, tree(SERVES), "0.7.162", "a".repeat(40));
  const launched = await run(data, tree(THROWS), "0.7.166");
  expect(launched.ran).toBe("rollback");
  expect(launched.line).toBe("0.7.166: it exited with 1 before it was ready; rolled back to 0.7.162");
  expect(await healthAt(launched.port)).toMatchObject({ version: "0.7.162", commit: "a".repeat(40) });
  expect(rolledBack(data)).toMatchObject({ from: "0.7.166", to: "0.7.162", paged: false });
  expect(rollbackNeed(data)?.sentence).toBe(
    "Release 0.7.166 did not become ready (it exited with 1 before it was ready); rolled back to 0.7.162.",
  );
  expect(lastGood(data)?.version).toBe("0.7.162");
});

test("a version that never becomes ready is undone when the grace runs out, well inside five minutes", async () => {
  expect(READY_GRACE_MS).toBeLessThan(5 * 60_000);
  const data = join(root, "data-hangs");
  keepGood(data, tree(SERVES), "0.7.162", null);
  const launched = await run(data, tree(HANGS), "0.7.167", 2_000);
  expect(launched.ran).toBe("rollback");
  expect(launched.line).toBe("0.7.167: not ready within 2s; rolled back to 0.7.162");
  expect(await healthAt(launched.port)).toMatchObject({ version: "0.7.162" });
});

test("with nothing kept, or only itself, there is nothing to roll back to", async () => {
  expect(await run(join(root, "data-empty"), tree(THROWS), "0.7.166")).toMatchObject({
    ran: "none",
    line: "0.7.166: it exited with 1 before it was ready; no earlier release is kept to roll back to",
  });
  const self = join(root, "data-self");
  keepGood(self, tree(SERVES), "0.7.166", null);
  expect((await run(self, tree(THROWS), "0.7.166")).ran).toBe("none");
  expect(rolledBack(self)).toBeUndefined();
});

test("the next version that reads ready replaces the kept tree and clears the rollback", async () => {
  const data = join(root, "data-next");
  keepGood(data, tree(SERVES), "0.7.162", null);
  await run(data, tree(THROWS), "0.7.166");
  await reap();
  markRollbackPaged(data);
  expect(rolledBack(data)?.paged).toBe(true);
  expect((await run(data, tree(SERVES), "0.7.167")).ran).toBe("release");
  expect(readdirSync(join(data, "release", "good"))).toEqual(["0.7.167"]);
  expect(rolledBack(data)).toBeUndefined();
});

test("a record that is not one reads as none", () => {
  const data = join(root, "data-garbage");
  mkdirSync(join(data, "release"), { recursive: true });
  writeFileSync(join(data, "release", "rolled-back.json"), "{nope");
  writeFileSync(join(data, "release", "good.json"), JSON.stringify({ version: "../x", at: "t" }));
  expect(rolledBack(data)).toBeUndefined();
  expect(lastGood(data)).toBeUndefined();
});

test("the image starts the launcher, and the launcher imports nothing a release could break", async () => {
  const repo = join(import.meta.dir, "..");
  expect(await Bun.file(join(repo, "Dockerfile")).text()).toContain('CMD ["bun", "src/release/launch.ts"]');
  // serving.ts (#8042) is the launcher's own sibling, node built-ins only, so the rule holds for both.
  for (const [file, sibling] of [["launch.ts", "./serving.ts"], ["serving.ts", undefined]] as const) {
    const source = await Bun.file(join(repo, "src/release", file)).text();
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source).map((i) => i.path);
    expect(imports.every((p) => p.startsWith("node:") || p === "bun" || p === sibling)).toBe(true);
  }
});
