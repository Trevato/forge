import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { directionRefusal } from "../scripts/gate.ts";

const root = mkdtempSync(join(tmpdir(), "direction-"));
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

const gateMain = (cwd: string, base: string) => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/gate.ts")], {
    cwd,
    env: { ...process.env, FORGE_CHECK_BASE: base },
  });
  return r.stderr.toString();
};

test("a range that adds a page alone is refused; a Direction line in its message waives it", async () => {
  const { dir, base } = repo("page");
  put(dir, "src/web/pages/machines.ts", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "Add machines");
  const out = await withBase(base, () => directionRefusal(dir));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain('rule "pipeline first"');
  // the gate's own entry point runs the rule, so removing its call goes red
  expect(gateMain(dir, base)).toContain('rule "pipeline first"');

  run(dir, "commit", "-q", "--allow-empty", "-m", "Waive\n\nDirection: a small door onto the spawn path, owner asked");
  expect(await withBase(base, () => directionRefusal(dir))).toEqual([]);
  expect(gateMain(dir, base)).not.toContain('rule "pipeline first"');
});

test("a range that adds the page with a pipeline change passes", async () => {
  const { dir, base } = repo("pipe");
  put(dir, "src/web/pages/machines.ts", "x");
  put(dir, "scripts/lint.ts", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "Add machines");
  expect(await withBase(base, () => directionRefusal(dir))).toEqual([]);
});
