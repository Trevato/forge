import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pinRefusal } from "../scripts/gate.ts";

const root = mkdtempSync(join(tmpdir(), "pin-refusal-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const gateScript = join(import.meta.dir, "../scripts/gate.ts");
const run = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const put = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};

/** A repo whose base commit has one pinned migration on it and one pin without. */
function repo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "work");
  put(dir, "src/core/migrations/0001-a.ts", "a");
  put(dir, "src/core/migration-pins/0001-a.pin", "x");
  put(dir, "src/core/migration-pins/0002-b.pin", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "base");
  return { dir, base: run(dir, "rev-parse", "HEAD") };
}

const withBase = async (base: string, f: () => Promise<string[]>) => {
  const old = process.env.FORGE_CHECK_BASE;
  process.env.FORGE_CHECK_BASE = base;
  try {
    return await f();
  } finally {
    if (old === undefined) delete process.env.FORGE_CHECK_BASE;
    else process.env.FORGE_CHECK_BASE = old;
  }
};

test("a modified pin whose migration is on the base is told to add a new migration", async () => {
  const { dir, base } = repo("modified");
  put(dir, "src/core/migration-pins/0001-a.pin", "y");
  run(dir, "commit", "-qam", "edit");
  const out = await withBase(base, () => pinRefusal(dir));
  expect(out).toEqual([
    "src/core/migration-pins/0001-a.pin was changed: a migration on main is history, so add a new migration instead",
  ]);
});

test("a pin whose migration is not on the base is told to delete it and re-run", async () => {
  const { dir, base } = repo("regen");
  put(dir, "src/core/migration-pins/0002-b.pin", "y");
  run(dir, "commit", "-qam", "edit");
  const out = await withBase(base, () => pinRefusal(dir));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("0002-b.pin");
  expect(out[0]).toContain("delete the pin and re-run");
});

test("a deleted pin whose migration is on the base is told to restore it", async () => {
  const { dir, base } = repo("deleted");
  run(dir, "rm", "-q", "src/core/migration-pins/0001-a.pin");
  run(dir, "commit", "-qm", "rm");
  const out = await withBase(base, () => pinRefusal(dir));
  expect(out).toEqual([
    "src/core/migration-pins/0001-a.pin was deleted: a migration on main is history, so restore it",
  ]);
});

test("an added pin passes", async () => {
  const { dir, base } = repo("added");
  put(dir, "src/core/migration-pins/0003-c.pin", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "add");
  expect(await withBase(base, () => pinRefusal(dir))).toEqual([]);
});

test("`bun scripts/gate.ts` exits 2 and names the edited pin", () => {
  const { dir, base } = repo("entry");
  put(dir, "src/core/migration-pins/0001-a.pin", "y");
  run(dir, "commit", "-qam", "edit");
  const r = Bun.spawnSync(["bun", gateScript], { cwd: dir, env: { ...process.env, FORGE_CHECK_BASE: base } });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("src/core/migration-pins/0001-a.pin");
});

test("with no base it warns on stderr instead of passing silently", async () => {
  const { dir } = repo("nobase");
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void seen.push(a.join(" "));
  const old = process.env.FORGE_CHECK_BASE;
  delete process.env.FORGE_CHECK_BASE;
  try {
    expect(await pinRefusal(dir)).toEqual([]);
  } finally {
    console.error = orig;
    if (old !== undefined) process.env.FORGE_CHECK_BASE = old;
  }
  expect(seen.join("\n")).toContain("pins not checked");
});
