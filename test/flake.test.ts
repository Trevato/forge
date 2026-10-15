/**
 * The flake machinery (`scripts/flake.ts`, `scripts/flake-hunt.ts`): what
 * is flaky, what the issue carries, how quarantine edits the list, how
 * admission is recorded, and that nothing in the gate retries.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditGate, GATE, type Exclusion } from "../scripts/gate.ts";
import {
  admissionRecord,
  admitted,
  ADMISSION_RUNS,
  findBroken,
  findFlakes,
  flakyFile,
  huntedFile,
  HUNT_RUNS,
  issueFor,
  quarantine,
  readRun,
  retries,
  ROOT_CAUSES,
  shuffled,
  tightBounds,
  WALL_CLOCK_FLOOR_MS,
} from "../scripts/flake.ts";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "forge-flake-"));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// What `bun test` prints out of a terminal: no `(pass)` lines, only fails.
const RED = [
  "bun test v1.3.14 (0d9b296a)",
  "",
  "test/a.test.ts:",
  "boom text",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 2",
  "Received: 1",
  "(fail) d > wobbly [7.35ms]",
  "",
  " --seed=5",
  " 1 pass",
  " 1 fail",
].join("\n");
const GREEN = "test/a.test.ts:\n\n 2 pass\n 0 fail\n";

describe("reading a run", () => {
  test("a red run keeps its failing names and the text above them", () => {
    const run = readRun("test/a.test.ts", 5, 1, RED);
    expect(run).toMatchObject({ green: false, seed: 5 });
    expect(run.failing).toEqual(["d > wobbly"]);
    expect(run.text).toContain("Expected: 2");
    expect(run.text).toContain("(fail) d > wobbly");
  });

  test("the exit code is the verdict, not the lines", () => {
    // A file that crashed outside a test prints no `(fail)` line.
    const crashed = readRun("test/a.test.ts", 1, 1, "error: port in use");
    expect(crashed.green).toBe(false);
    expect(crashed.failing).toEqual([]);
    expect(crashed.text).toContain("port in use");
    expect(readRun("test/a.test.ts", 1, 0, GREEN)).toMatchObject({
      green: true,
      text: "",
    });
  });
});

describe("finding flakes", () => {
  const runs = [
    readRun("test/a.test.ts", 11, 0, GREEN),
    readRun("test/a.test.ts", 22, 1, RED),
    readRun("test/a.test.ts", 33, 0, GREEN),
    readRun("test/b.test.ts", 11, 1, "(fail) always"),
    readRun("test/b.test.ts", 22, 1, "(fail) always"),
    readRun("test/c.test.ts", 11, 0, GREEN),
    readRun("test/c.test.ts", 22, 0, GREEN),
  ];

  test("a file red in one run and green in another is flaky", () => {
    const flakes = findFlakes(runs);
    expect(flakes.map((flake) => flake.file)).toEqual(["test/a.test.ts"]);
    expect(flakes[0]).toMatchObject({
      red: 1,
      green: 2,
      seed: 22,
      failing: ["d > wobbly"],
    });
  });

  test("a file red every time is broken, not flaky", () => {
    expect(findBroken(runs)).toEqual(["test/b.test.ts"]);
  });
});

describe("the issue", () => {
  const flake = findFlakes([
    readRun("test/a.test.ts", 1, 0, GREEN),
    readRun("test/a.test.ts", 99, 1, RED),
  ])[0]!;
  const { title, body } = issueFor(flake, "https://ci/runs/9");

  test("carries the failure text, the seed and the run that failed", () => {
    expect(title).toBe("Flaky: test/a.test.ts");
    expect(body).toContain("Expected: 2");
    expect(body).toContain("--seed=99");
    expect(body).toContain("https://ci/runs/9");
    expect(body).toContain("`d > wobbly`");
  });

  test("names every root cause, and refuses a retry as the fix", () => {
    expect(ROOT_CAUSES.map((cause) => cause.name)).toEqual([
      "a shared port",
      "a real clock",
      "order dependence",
      "a leaked server",
      "a timeout set near the real duration",
      "a tight wall-clock bound",
    ]);
    for (const cause of ROOT_CAUSES)
      expect(body).toContain(`- [ ] ${cause.name}`);
    expect(body).toContain("A retry is not a fix");
  });

  test("its title is how quarantine finds the file again", () => {
    expect(flakyFile(title)).toBe("test/a.test.ts");
    expect(flakyFile("Flaky: test/../etc/x.test.ts")).toBeUndefined();
    expect(flakyFile("Flaky: src/main.ts")).toBeUndefined();
    expect(flakyFile("Something else: test/a.test.ts")).toBeUndefined();
  });

  test("only an issue the hunt itself filed quarantines a file", () => {
    const hunt = "01huntuser";
    expect(huntedFile({ title, authorId: hunt }, hunt)).toBe("test/a.test.ts");
    expect(huntedFile({ title, authorId: hunt, untrusted: false }, hunt)).toBe(
      "test/a.test.ts",
    );
    expect(
      huntedFile({ title, authorId: "01someoneelse" }, hunt),
    ).toBeUndefined();
    expect(huntedFile({ title }, hunt)).toBeUndefined();
    expect(
      huntedFile({ title, authorId: hunt, untrusted: true }, hunt),
    ).toBeUndefined();
    expect(huntedFile({ title, authorId: "" }, "")).toBeUndefined();
  });
});

describe("quarantine", () => {
  const source = read("scripts/gate.ts");
  const file = GATE[0]!;

  test("moves the file from GATE to EXCLUDED under the issue", async () => {
    const moved = quarantine(source, file, 4242);
    expect(moved).not.toBe(source);
    const dir = await scratch();
    await writeFile(join(dir, "gate.ts"), moved);
    const mod = (await import(join(dir, "gate.ts"))) as {
      GATE: readonly string[];
      EXCLUDED: readonly Exclusion[];
    };
    const present = readdirSync(`${root}test`)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`);
    expect(auditGate(present, mod.GATE, mod.EXCLUDED)).toEqual([]);
    expect(mod.GATE).not.toContain(file);
    expect(mod.GATE).toHaveLength(GATE.length - 1);
    expect(mod.EXCLUDED.at(-1)).toMatchObject({ file, issue: 4242 });
  });

  test("a file not in GATE is left alone", async () => {
    const { EXCLUDED } = await import("../scripts/gate.ts");
    expect(quarantine(source, EXCLUDED[0]!.file, 1)).toBe(source);
    expect(quarantine(source, "test/nope.test.ts", 1)).toBe(source);
  });
});

describe("admission", () => {
  test("needs ten runs, all green; the hunt runs five", () => {
    expect(ADMISSION_RUNS).toBe(10);
    expect(HUNT_RUNS).toBe(5);
    const green = Array.from({ length: 10 }, () => ({ green: true }));
    expect(admitted(green)).toBe(true);
    expect(admitted(green.slice(1))).toBe(false);
    expect(admitted([...green.slice(1), { green: false }])).toBe(false);
  });

  test("the record names every seed", () => {
    const record = admissionRecord("test/x.test.ts", [
      { seed: 5, green: true },
      { seed: 6, green: false },
    ]);
    expect(record).toContain("1/2 green");
    expect(record).toContain("run 2: seed 6 RED");
  });

  test("`admit` runs the file in random order and refuses fewer than ten", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "test"));
    await writeFile(
      join(dir, "test", "x.test.ts"),
      'import { test } from "bun:test";\ntest("one", () => {});\n',
    );
    const child = Bun.spawn(
      [
        "bun",
        join(root, "scripts/flake-hunt.ts"),
        "admit",
        "test/x.test.ts",
        "--runs",
        "2",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const [out, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(out).toContain("admission: test/x.test.ts — 2/2 green");
    expect(out).toMatch(/run 2: seed \d+ green/);
    expect(code).toBe(1);
  }, 120_000); // two `bun test` children beside busy loops: past the 5 s default
});

describe("random order", () => {
  const files = Array.from({ length: 30 }, (_, i) => `test/f${i}.test.ts`);

  test("a seed fixes the order, and another seed moves it", () => {
    expect(shuffled(files, 7)).toEqual(shuffled(files, 7));
    expect(shuffled(files, 7)).not.toEqual(shuffled(files, 8));
    expect([...shuffled(files, 7)].sort()).toEqual([...files].sort());
  });
});

describe("no retry in the gate", () => {
  test("the detector sees a retry", () => {
    expect(retries("x", "bun test --retry=3")).toHaveLength(1);
    expect(retries("x", "bun test --rerun-each 3")).toHaveLength(1);
    expect(retries("x", "retry = 2")).toHaveLength(1);
    expect(retries("x", 'test("a", () => {}, { retry: 2 });')).toHaveLength(1);
    expect(retries("x", 'expect(text).toContain("retry: 1000");')).toEqual([]);
  });

  test("nothing the gate runs, or runs it, retries", () => {
    const named = [
      "forge.json",
      "bunfig.toml",
      "package.json",
      "scripts/test-shards.ts",
      "scripts/check.ts",
      ...readdirSync(`${root}.forgejo/workflows`).map(
        (name) => `.forgejo/workflows/${name}`,
      ),
      // This file holds the detector's own examples.
      ...GATE.filter((file) => file !== "test/flake.test.ts"),
    ];
    expect(named.flatMap((path) => retries(path, read(path)))).toEqual([]);
  });
});

describe("no tight wall-clock bound in a test", () => {
  test("the detector sees a measured time bounded below the floor", () => {
    expect(WALL_CLOCK_FLOOR_MS).toBe(200);
    expect(
      tightBounds("x", "expect(times[2]!).toBeLessThan(50);"),
    ).toHaveLength(1);
    expect(
      tightBounds(
        "x",
        "expect(performance.now() - t0).toBeLessThanOrEqual(1_99);",
      ),
    ).toHaveLength(1);
    expect(tightBounds("x", "expect(elapsed).toBeLessThan(100);")).toHaveLength(
      1,
    );
    expect(tightBounds("x", "expect(out.ms).toBeLessThan(150);")).toHaveLength(
      1,
    );
    // At the floor, or above it, is generous enough.
    expect(tightBounds("x", "expect(times[2]!).toBeLessThan(200);")).toEqual(
      [],
    );
    expect(tightBounds("x", "expect(elapsed).toBeLessThan(2_000);")).toEqual(
      [],
    );
    // A count or a size is not a clock.
    expect(tightBounds("x", "expect(lines.length).toBeLessThan(20);")).toEqual(
      [],
    );
    expect(tightBounds("x", "expect(res.status).toBeLessThan(400);")).toEqual(
      [],
    );
  });

  test("no test file bounds a request or a spawn below the floor", () => {
    const files = readdirSync(`${root}test`)
      .filter((name) => name.endsWith(".test.ts"))
      // This file holds the detector's own examples.
      .filter((name) => name !== "flake.test.ts")
      .map((name) => `test/${name}`);
    expect(files.flatMap((path) => tightBounds(path, read(path)))).toEqual([]);
  });
});
