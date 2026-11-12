/**
 * A pull is not red for main's red (#10304): when a fast tier's red test is
 * red on the pull's base too, with the same tests, the check says so and is
 * green; any other red is the pull's. Once end to end through
 * `scripts/test-shards.ts`, in a scratch repository of trivial tests.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXCLUDED } from "../scripts/gate.ts";
import { askBase, baseVerdict, BASE_RERUN_CAP, clearedIn, type OnBase } from "../src/checks/base_red.ts";

const BASE = "0123456789abcdef0123456789abcdef01234567";
const red = (...failing: string[]) => ({ did: "red" as const, failing });

describe("whose red it is", () => {
  test("a file red on the base with the same tests is main's, and clears the run", () => {
    const got = baseVerdict(
      new Map([["test/a.test.ts", ["x"]]]),
      new Map([["test/a.test.ts", red("x", "y")]]),
      BASE,
    );
    expect(got.cleared).toBe(true);
    expect(got.lines).toEqual([
      "test/a.test.ts is red on main at 0123456 too, the same tests: not counted against this pull",
      "green: every red test is red on main at 0123456 too, so it is main's, not this pull's (test/a.test.ts)",
    ]);
  });

  test("a second break in a file main already has red is the pull's", () => {
    const got = baseVerdict(
      new Map([["test/a.test.ts", ["x", "new break"]]]),
      new Map([["test/a.test.ts", red("x")]]),
      BASE,
    );
    expect(got.cleared).toBe(false);
    expect(got.lines).toEqual([
      `test/a.test.ts is red on main at 0123456 too, but "new break" passes there: this pull's red`,
    ]);
  });

  test("a base red that names no test cannot be compared, and keeps the run red", () => {
    const got = baseVerdict(new Map([["test/a.test.ts", ["x"]]]), new Map([["test/a.test.ts", red()]]), BASE);
    expect(got.cleared).toBe(false);
    expect(got.lines[0]).toContain("names no failing test there to compare: this pull's red");
  });

  test("one red file green on the base, absent from it or not run keeps the run red", () => {
    for (const did of [{ did: "green" as const }, { did: "absent" as const }, undefined]) {
      const onBase = new Map<string, OnBase>([["test/a.test.ts", red("x")]]);
      if (did !== undefined) onBase.set("test/b.test.ts", did);
      const got = baseVerdict(new Map([["test/a.test.ts", ["x"]], ["test/b.test.ts", ["z"]]]), onBase, BASE);
      expect(got.cleared).toBe(false);
      expect(got.lines[0]).toContain("test/a.test.ts is red on main");
      expect(got.lines[1]).toMatch(/^test\/b\.test\.ts .*: this pull's red$/);
    }
  });

  test("a cleared run's summary keeps main's red; a run that cleared none keeps nothing", () => {
    const { lines } = baseVerdict(new Map([["test/a.test.ts", ["x"]]]), new Map([["test/a.test.ts", red("x")]]), BASE);
    const output = ["(pass) b", ...lines.map((line) => `test-shards: ${line}`), "exit 0"];
    expect(clearedIn(output)).toBe("red on main at 0123456, not this pull's: test/a.test.ts");
    const kept = baseVerdict(new Map([["test/a.test.ts", ["x", "y"]]]), new Map([["test/a.test.ts", red("x")]]), BASE);
    expect(clearedIn(kept.lines.map((line) => `test-shards: ${line}`))).toBeUndefined();
    // A test printing the words is not the script's verdict.
    expect(clearedIn([`  ${lines.at(-1)}`])).toBeUndefined();
  });

  test("the base is not asked about a red with no file or test, a changed file, or too many", () => {
    const one = (file: string, ...tests: string[]) => new Map([[file, tests]]);
    expect(askBase({ red: undefined, changed: [] })).toBeUndefined();
    expect(askBase({ red: new Map(), changed: [] })).toBeUndefined();
    expect(askBase({ red: one("test/a.test.ts"), changed: ["README.md"] })).toBeUndefined();
    expect(askBase({ red: one("test/a.test.ts", "x"), changed: ["test/a.test.ts"] })).toBeUndefined();
    const many = new Map(Array.from({ length: BASE_RERUN_CAP + 1 }, (_, i) => [`test/t${i}.test.ts`, ["x"]]));
    expect(askBase({ red: many, changed: ["README.md"] })).toBeUndefined();
    expect(askBase({ red: one("test/a.test.ts", "x"), changed: ["README.md"] })).toEqual(["test/a.test.ts"]);
  });
});

describe("the fast tier asks main", () => {
  const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
  const RED = "test/unreached.test.ts";
  const pass = `import { test } from "bun:test";\ntest("ok", () => {});\n`;
  const fail = `import { expect, test } from "bun:test";\ntest("red", () => { expect(1).toBe(2); });\n`;
  const git = (dir: string, ...args: string[]): number =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode;
  const env: Record<string, string | undefined> = { ...process.env, FORGE_CHECK_SHARDS: "2", FORGE_CELL_CPUS: "2" };
  for (const name of Object.keys(env)) if (name.startsWith("FORGE_CHECK_") && name !== "FORGE_CHECK_SHARDS") delete env[name];

  /** Main with RED as `onMain`, a pull that changes `pull`; the fast check of the pull. */
  const check = async (onMain: string, pull: Record<string, string>, alsoOnMain: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "red-on-main-"));
    try {
      mkdirSync(join(dir, "test"));
      // The gate refuses a tree its EXCLUDED list names files missing from; they never run.
      for (const { file } of EXCLUDED) writeFileSync(join(dir, file), pass);
      writeFileSync(join(dir, RED), onMain);
      writeFileSync(join(dir, "test/plain.test.ts"), pass);
      writeFileSync(join(dir, "README.md"), "# scratch\n");
      for (const [file, text] of Object.entries(alsoOnMain)) {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      expect(git(dir, "init", "-q")).toBe(0);
      expect(git(dir, "add", "-A")).toBe(0);
      expect(git(dir, "commit", "-qm", "main")).toBe(0);
      for (const [file, text] of Object.entries(pull)) writeFileSync(join(dir, file), text);
      expect(git(dir, "add", "-A")).toBe(0);
      expect(git(dir, "commit", "-qm", "the pull")).toBe(0);
      const child = Bun.spawn(["bun", script, "--tier", "fast", "--diff", "HEAD~1..HEAD"], {
        cwd: dir,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code: await child.exited, out };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a README-only pull opened while main fails a test is green, and names main's red", async () => {
    const got = await check(fail, { "README.md": "# scratch, changed\n" });
    expect(got.out).toContain(`${RED} is red on main at HEAD~1 too, the same tests: not counted against this pull`);
    expect(got.out).toContain("green: every red test is red on main at HEAD~1 too");
    expect(clearedIn(got.out.split("\n"))).toBe(`red on main at HEAD~1, not this pull's: ${RED}`);
    expect(got.code).toBe(0);
  }, 60_000);

  test("a pull that changes main's red file is red: its red is its own to answer", async () => {
    const got = await check(fail, { [RED]: `${fail}test("also red", () => { expect(2).toBe(3); });\n` });
    expect(got.out).not.toContain("green: every red test is red on main");
    expect(got.code).not.toBe(0);
  }, 60_000);

  test("a pull that adds a second break to main's red file without touching it is red", async () => {
    const two = `import { expect, test } from "bun:test";\nimport { two } from "../src/two.ts";\n` +
      `test("red", () => { expect(1).toBe(2); });\ntest("second", () => { expect(two).toBe(2); });\n`;
    const got = await check(two, { "src/two.ts": "export const two = 3;\n" }, { "src/two.ts": "export const two = 2;\n" });
    expect(got.out).toContain(`"second" passes there: this pull's red`);
    expect(got.out).not.toContain("green: every red test is red on main");
    expect(got.code).not.toBe(0);
  }, 60_000);
});
