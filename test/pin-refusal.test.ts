import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pinRefusal } from "../scripts/gate.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";

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

test("in a repository with no base it refuses instead of passing unchecked", async () => {
  const { dir } = repo("nobase");
  const out = await withBase(undefined, () => pinRefusal(dir));
  expect(out).toHaveLength(1);
  expect(out[0]).toStartWith("no base to compare to: a migration on main is history");
});

test("a tree with no git history (the full check's export) says so on stderr and passes", async () => {
  const dir = join(root, "export");
  put(dir, "src/core/migration-pins/0001-a.pin", "x");
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void seen.push(a.join(" "));
  try {
    expect(await withBase(undefined, () => pinRefusal(dir))).toEqual([]);
  } finally {
    console.error = orig;
  }
  expect(seen.join("\n")).toContain("pins not checked");
});

/**
 * #8103's history (#8352): the branch lands a migration and its pin by
 * squash, then, still holding its pre-squash commit, edits both. The merge
 * base predates the squash, so against it the pin reads as added.
 */
function squashed(name: string) {
  const { dir, base } = repo(name);
  const migration = "src/core/migrations/0005-e.ts";
  const pin = "src/core/migration-pins/0005-e.pin";
  put(dir, migration, "create index e");
  put(dir, pin, "v1");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "add e");
  run(dir, "checkout", "-q", "-b", "main", base);
  put(dir, migration, "create index e");
  put(dir, pin, "v1");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "add e (#1) squashed");
  run(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  run(dir, "checkout", "-q", "work");
  return { dir, migration, pin };
}

test("an edit to a pin a squash already landed on main is refused", async () => {
  const { dir, migration, pin } = squashed("squash-edit");
  put(dir, migration, "create index e2 where x");
  put(dir, pin, "v2");
  run(dir, "commit", "-qam", "edit e");
  expect(await withBase(undefined, () => pinRefusal(dir))).toEqual([
    `${pin} was changed: a migration on main is history, so add a new migration instead`,
  ]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "FORGE_CHECK_BASE"));
  const r = Bun.spawnSync(["bun", gateScript], { cwd: dir, env });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain(`gate: ${pin} was changed: a migration on main is history`);
});

test("deleting a pin a squash already landed on main is refused", async () => {
  const { dir, pin } = squashed("squash-delete");
  run(dir, "rm", "-q", pin);
  run(dir, "commit", "-qm", "rm e");
  expect(await withBase(undefined, () => pinRefusal(dir))).toContain(
    `${pin} was deleted: a migration on main is history, so restore it`,
  );
});

test("a pull that keeps the squashed pin as landed passes", async () => {
  const { dir } = squashed("squash-kept");
  put(dir, "src/other.ts", "more work");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "more");
  expect(await withBase(undefined, () => pinRefusal(dir))).toEqual([]);
});

test("a pull rebased onto main passes, and so does one behind main's newer pins", async () => {
  const { dir, base } = repo("rebased");
  run(dir, "checkout", "-q", "-b", "main");
  put(dir, "src/core/migrations/0006-f.ts", "f");
  put(dir, "src/core/migration-pins/0006-f.pin", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "f on main");
  run(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  run(dir, "checkout", "-q", "-b", "behind", base);
  put(dir, "src/other.ts", "work");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "work");
  expect(await withBase(undefined, () => pinRefusal(dir))).toEqual([]);
  run(dir, "rebase", "-q", "main");
  expect(await withBase(undefined, () => pinRefusal(dir))).toEqual([]);
});

test("a migration added without its pin is named with the one-step fix, last, as the check's summary", async () => {
  const { dir, base } = repo("unpinned");
  put(dir, "src/core/migrations/0003-c.ts", "c");
  put(dir, "src/core/migrations/0004-d.ts", "d");
  put(dir, "src/core/migration-pins/0004-d.pin", "x");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "add");
  const out = await withBase(base, () => pinRefusal(dir));
  const named =
    "this pull adds migration 0003-c without its pin: run bun scripts/pin-migrations.ts and commit src/core/migration-pins/0003-c.pin";
  expect(out).toEqual([named]);
  const r = Bun.spawnSync(["bun", gateScript], { cwd: dir, env: { ...process.env, FORGE_CHECK_BASE: base } });
  expect(r.exitCode).toBe(2);
  const lines = r.stderr.toString().split("\n");
  expect(summariseCheckFailure(lines, "check exited with code 2").summary).toBe(`gate: ${named}`);
});
