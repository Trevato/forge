import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bothDoorsRefusal } from "../scripts/gate.ts";

const root = mkdtempSync(join(tmpdir(), "both-doors-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const put = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const withBase = async (base: string | undefined, f: () => Promise<string[]>) => {
  const old = process.env.FORGE_CHECK_BASE;
  if (base === undefined) delete process.env.FORGE_CHECK_BASE;
  else process.env.FORGE_CHECK_BASE = base;
  try {
    return await f();
  } finally {
    if (old === undefined) delete process.env.FORGE_CHECK_BASE;
    else process.env.FORGE_CHECK_BASE = old;
  }
};
function repo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "work");
  put(dir, "README.md", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "base");
  return { dir, base: run(dir, "rev-parse", "HEAD") };
}

test("a commit range that adds a page alone is refused; a No door line in its message waives it", async () => {
  const { dir, base } = repo("page");
  put(dir, "src/web/pages/traffic.ts", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "Add traffic");
  const out = await withBase(base, () => bothDoorsRefusal(dir));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("but no terminal screen in src/tui/");
  expect(out[0]).toContain("and no docs/features/<name>.md how-to");

  run(dir, "commit", "-q", "--allow-empty", "-m", "Waive\n\nNo door: a public landing page, nothing to administer");
  expect(await withBase(base, () => bothDoorsRefusal(dir))).toEqual([]);
});

test("a range that adds the page with both doors passes", async () => {
  const { dir, base } = repo("doors");
  put(dir, "src/web/pages/traffic.ts", "x");
  put(dir, "src/tui/screens/traffic.ts", "x");
  put(dir, "docs/features/traffic.md", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "Add traffic");
  expect(await withBase(base, () => bothDoorsRefusal(dir))).toEqual([]);
});
