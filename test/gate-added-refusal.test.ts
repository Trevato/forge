import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedRefusal } from "../scripts/gate.ts";

const CAST = "f(row as" + " never);";
const dirs: string[] = [];
const saved = process.env.FORGE_CHECK_BASE;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.FORGE_CHECK_BASE;
  else process.env.FORGE_CHECK_BASE = saved;
});

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

/** A repository with a base commit and a head commit that adds a cast in a test file. */
function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "forge-added-"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "trunk");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test/a.test.ts"), "const a = 1;\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "base");
  const base = sh(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "test/a.test.ts"), `const a = 1;\n${CAST}\n`);
  sh(dir, "commit", "-qam", "head");
  return { dir, base };
}

test("the gate names the rule for a cast the head commit adds, judged from FORGE_CHECK_BASE", async () => {
  const { dir, base } = repo();
  process.env.FORGE_CHECK_BASE = base;
  const out = await addedRefusal(dir);
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("rule \"a test builds the real input");
  expect(out[0]).toContain("test/a.test.ts:2");
});

test("the gate passes when no base resolves", async () => {
  const { dir } = repo();
  delete process.env.FORGE_CHECK_BASE;
  expect(await addedRefusal(dir)).toEqual([]);
});
