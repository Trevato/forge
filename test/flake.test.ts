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
import { auditGate, EXCLUDED, gateFiles, outsideFiles, presentTests, type Exclusion } from "../scripts/gate.ts";
import {
  admissionRecord,
  admitted,
  ADMISSION_RUNS,
  fallThroughWaits,
  FALL_THROUGH_OWED,
  findBroken,
  findFlakes,
  flakyFile,
  huntedFile,
  HUNT_RUNS,
  issueFor,
  quarantine,
  quarantineFlaky,
  redActions,
  redFile,
  redIssueFor,
  readRun,
  retries,
  ROOT_CAUSES,
  shuffled,
  tightBounds,
  rawBudgets,
  WALL_CLOCK_FLOOR_MS,
} from "../scripts/flake.ts";
import { breaches } from "./helpers/rule.ts";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");
// Every test file the wall-clock rules read; this file holds the detectors' own examples.
const scanned = readdirSync(`${root}test`)
  .filter((name) => name.endsWith(".test.ts") && name !== "flake.test.ts")
  .map((name) => `test/${name}`);

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
  const file = gateFiles()[0]!;

  test("takes the file out of the gate into EXCLUDED under the issue", async () => {
    const moved = quarantine(source, file, 4242);
    expect(moved).not.toBe(source);
    const dir = await scratch();
    await writeFile(join(dir, "gate.ts"), moved);
    const mod = (await import(join(dir, "gate.ts"))) as {
      EXCLUDED: readonly Exclusion[];
      gateFiles: (present?: readonly string[]) => string[];
    };
    const present = readdirSync(`${root}test`)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`)
      .sort();
    expect(auditGate(present, mod.EXCLUDED)).toEqual([]);
    const gate = mod.gateFiles(present);
    expect(gate).not.toContain(file);
    expect(gate).toHaveLength(gateFiles().length - 1);
    expect(mod.EXCLUDED.at(-1)).toMatchObject({ file, issue: 4242 });
  });

  test("a file excluded already is left alone", async () => {
    const once = quarantine(source, file, 1);
    expect(quarantine(once, file, 2)).toBe(once);
    expect(quarantine("no list here", file, 1)).toBe("no list here");
  });
});

describe("quarantineFlaky", () => {
  const source = read("scripts/gate.ts");
  const file = gateFiles()[0]!;
  const present = new Set(gateFiles());

  test("an issue naming a missing file adds no EXCLUDED entry", () => {
    const got = quarantineFlaky(source, [["test/gone.test.ts", 77]], present);
    expect(got.source).toBe(source);
    expect(got.moved).toEqual([]);
  });

  test("a present file is quarantined and named; one excluded already is not", () => {
    const got = quarantineFlaky(
      source,
      [
        ["test/gone.test.ts", 77],
        [file, 78],
        [file, 79],
      ],
      present,
    );
    expect(got.source).toBe(quarantine(source, file, 78));
    expect(got.moved).toEqual([`${file} (#78)`]);
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

describe("a wait that runs out of time and carries on (#9017)", () => {
  // test/conversation-queue.test.ts before #8995: ran out after 4 s and went on to steer a turn whose partial was unread.
  const QUEUE_BEFORE = [
    "const until = async (ok: () => boolean): Promise<void> => {",
    "  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(20);",
    "};",
  ].join("\n");
  const QUEUE_AFTER = [
    "const until = async (ok: () => boolean, what = \"the condition\"): Promise<void> => {",
    "  for (let i = 0; i < 500 && !ok(); i++) await Bun.sleep(20);",
    "  if (!ok()) throw new Error(`timed out waiting for ${what}`);",
    "};",
  ].join("\n");

  test("the detector sees a poll that falls through, in each shape", () => {
    expect(fallThroughWaits("q", QUEUE_BEFORE)).toEqual(["q:2: for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(20);"]);
    const braced = "for (let i = 0; i < 100 && !h.text().includes(what); i++) {\n  await Bun.sleep(20);\n  await h.press();\n}\n}";
    expect(fallThroughWaits("t", braced)).toHaveLength(1);
    expect(fallThroughWaits("d", "while (Date.now() < deadline && !done()) await Bun.sleep(20);\nact();")).toHaveLength(1);
    expect(fallThroughWaits("n", "for (let i = 0; i < 9 && (await bytes()) < 5; i++)\n  await Bun.sleep(20);\nact();")).toHaveLength(1);
  });

  test("a poll whose outcome is checked or handed back is no breach", () => {
    expect(fallThroughWaits("q", QUEUE_AFTER)).toEqual([]);
    expect(fallThroughWaits("e", "for (let i = 0; i < 9 && !ok(); i++) await Bun.sleep(20);\nexpect(ok()).toBe(true);")).toEqual([]);
    expect(fallThroughWaits("r", "while (Date.now() < end && !ok()) await Bun.sleep(5);\nreturn ok();")).toEqual([]);
    // A loop that never waits is no poll.
    expect(fallThroughWaits("s", "for (let i = 0; i < 9 && n > 0; i++) n--;\nact();")).toEqual([]);
  });

  test("`admit` refuses it before any run, naming the line", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "test"));
    await writeFile(
      join(dir, "test", "x.test.ts"),
      `import { test } from "bun:test";\n${QUEUE_BEFORE}\ntest("one", async () => { await until(() => true); });\n`,
    );
    const child = Bun.spawn(["bun", join(root, "scripts/flake-hunt.ts"), "admit", "test/x.test.ts"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(out).toContain("admission: test/x.test.ts — refused, a wait runs out of time and carries on");
    expect(out).toContain("test/x.test.ts:3: for (let i = 0; i < 200 && !ok(); i++)");
    expect(out).not.toContain("run 1:");
    expect(code).toBe(1);
  }, 30_000); // one bun child, no runs
});

  // A new file is refused here, on its own first check, not only by an `admit` it may never get.
  breaches(
    "no test file waits on a poll that runs out of time and carries on",
    scanned.filter((path) => !FALL_THROUGH_OWED.has(path)).flatMap((path) => fallThroughWaits(path, read(path))),
  );
  breaches(
    "every file owed under #9025 still owes a fix: strike the ones fixed",
    [...FALL_THROUGH_OWED]
      .filter((path) => !scanned.includes(path) || fallThroughWaits(path, read(path)).length === 0)
      .map((path) => `${path}: no fall-through wait left (or no such file); delete it from FALL_THROUGH_OWED in scripts/flake.ts`),
  );

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
      ...gateFiles().filter((file) => file !== "test/flake.test.ts"),
    ];
    expect(named.flatMap((path) => retries(path, read(path)))).toEqual([]);
  }, 120_000); // reads every gate file: past the 5 s default on a loaded machine
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

  breaches(
    "no test file bounds a request or a spawn below the floor",
    scanned.flatMap((path) => tightBounds(path, read(path))),
  );
});

describe("no raw wall-clock budget in a test (#4429)", () => {
  test("the detector sees a raw ms bound and a title promising one", () => {
    expect(rawBudgets("x", "expect(dur(\"app\")).toBeLessThan(50);")).toHaveLength(1);
    expect(rawBudgets("x", "expect(total).toBeLessThan(50);")).toHaveLength(1);
    expect(rawBudgets("x", "test(`GET /a answers under 50 ms`, () => {});")).toHaveLength(1);
    expect(rawBudgets("x", "expect(elapsed).toBeLessThan(5_000);")).toEqual([]); // a hang guard
    expect(rawBudgets("x", "expect(res.status).toBeLessThan(400);")).toEqual([]);
    expect(rawBudgets("x", "expect(lines.length).toBeLessThan(20);")).toEqual([]);
  });

  breaches(
    "no test file holds a speed to a raw ms number",
    scanned.flatMap((path) => rawBudgets(path, read(path))),
  );
});

describe("the scheduled run of the files outside the gate", () => {
  const present = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
  const excluded: Exclusion[] = [
    { file: "test/b.test.ts", reason: "r", issue: 1 },
  ];
  const run = (file: string, failing: string[] = []) =>
    readRun(file, 0, failing.length ? 1 : 0, failing.map((f) => `(fail) ${f}`).join("\n"));

  test("it runs exactly the files the gate does not", () => {
    expect(outsideFiles(present, excluded)).toEqual(["test/b.test.ts"]);
    const both = [...gateFiles(present, excluded), ...outsideFiles(present, excluded)];
    expect(both.sort()).toEqual(present);
    // A file moved into the gate is no longer run by the schedule.
    expect(outsideFiles(present, [])).toEqual([]);
  });

  test("the real lists partition the test files", () => {
    const all = presentTests();
    expect(outsideFiles(all)).toEqual(EXCLUDED.map((e) => e.file).sort());
    expect(new Set([...gateFiles(all), ...outsideFiles(all)]).size).toBe(all.length);
  });

  test("a newly red file opens one issue naming it and its first failing test", () => {
    const red = run("test/b.test.ts", ["first one", "second one"]);
    const actions = redActions([red], new Map());
    expect(actions).toEqual([{ kind: "open", run: red }]);
    const issue = redIssueFor(red, "http://run/1");
    expect(issue.title).toBe("Red: test/b.test.ts");
    expect(redFile(issue.title)).toBe("test/b.test.ts");
    expect(issue.body).toContain("`first one`");
    expect(issue.body).not.toContain("second one` ");
  });

  test("a file still red on the same test says nothing; on another it updates", () => {
    const red = run("test/b.test.ts", ["first one"]);
    const body = redIssueFor(red, "").body;
    const open = new Map([["test/b.test.ts", { number: 7, body }]]);
    expect(redActions([red], open)).toEqual([]);
    const other = run("test/b.test.ts", ["another"]);
    expect(redActions([other], open)).toEqual([{ kind: "update", run: other, number: 7 }]);
  });

  test("a file green again closes its issue; green with no issue does nothing", () => {
    const green = run("test/b.test.ts");
    expect(redActions([green], new Map([["test/b.test.ts", { number: 7 }]]))).toEqual([
      { kind: "close", file: "test/b.test.ts", number: 7 },
    ]);
    expect(redActions([green], new Map())).toEqual([]);
  });

  test("only Red: titles naming a test file count", () => {
    expect(redFile("Red: ../x.test.ts")).toBeUndefined();
    expect(redFile("Flaky: test/a.test.ts")).toBeUndefined();
    expect(redFile("Red: test/a.test.ts")).toBe("test/a.test.ts");
  });
});

describe("a crash outside any test that ran green on its re-run (#7781)", () => {
  const quoted = "  │ # Unhandled error between tests\n  │ error: Cannot use a closed database 42\n";
  test("is named by one stable line and read back as a flake with no file", async () => {
    const { crashFlakeLine, crashFlakes } = await import("../src/checks/flake.ts");
    const line = crashFlakeLine("3/9", quoted);
    expect(line).toBe("test-shards: crash flake 3/9: error: Cannot use a closed database #");
    const got = crashFlakes(["noise", line, line, "(fail) a real failing test"]);
    expect(got).toEqual([{ file: "", name: "(crash outside any test) error: Cannot use a closed database #" }]);
  });
  test("a real failing test is no crash flake", async () => {
    const { crashFlakes } = await import("../src/checks/flake.ts");
    expect(crashFlakes(["(fail) a [1ms]", " 1 fail"])).toEqual([]);
  });
});

test("a crash of another Error class keeps its own cause, not one shared bucket (#7781)", async () => {
  const { crashFlakeLine } = await import("../src/checks/flake.ts");
  expect(crashFlakeLine("1/2", "  │ SyntaxError: bad token 7\n")).toBe("test-shards: crash flake 1/2: SyntaxError: bad token #");
  expect(crashFlakeLine("1/2", "  │ AssertionError: x\n")).toContain("AssertionError");
  expect(crashFlakeLine("1/2", "  │ # Unhandled error between tests\n")).toBe("test-shards: crash flake 1/2: unhandled error");
});
