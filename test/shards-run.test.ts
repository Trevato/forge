/**
 * The gate's runner (`scripts/test-shards.ts`) end to end: each test spawns
 * it, and it spawns `bun test`, so each costs a few hundred milliseconds.
 * The pure parts it is built from (`scripts/shards.ts`) are proved in
 * test/shards.test.ts, which stays fast because it spawns nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRASH_RERUNS } from "../scripts/shards.ts";
import { EXCLUDED, gateFiles, presentTests } from "../scripts/gate.ts";

describe("where a shard writes", () => {
  test("its TMPDIR sits under FORGE_CHECK_SCRATCH, and a red shard logs the free space (#8679)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shards-scratch-"));
    const scratch = join(dir, "scratch");
    writeFileSync(
      join(dir, "where.test.ts"),
      `import { expect, test } from "bun:test";
test("temp is on the scratch", () => {
  console.log("TMP=" + process.env.TMPDIR);
  expect(false).toBe(true);
});
`,
    );
    const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
    const child = Bun.spawn(["bun", script, "where.test.ts"], {
      cwd: dir,
      env: { ...process.env, FORGE_CHECK_SHARDS: "1", FORGE_CHECK_SCRATCH: scratch },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
    expect(out).toContain(`TMP=${scratch}/shard-`);
    expect(out).toMatch(/test-shards: space after a red shard: scratch .*MiB free of/);
  }, 30_000);
});

describe("the shard's output", () => {
  // A check's log is this script's stdout, line by line, as the forge
  // reads it (`checks/service.ts`). Holding a shard's output until it
  // ended meant a forty-minute gate showed nothing at all until the end.
  test("one shard at a time: a line is written when the test says it, not when the shard ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shards-live-"));
    writeFileSync(
      join(dir, "live.test.ts"),
      `import { test } from "bun:test";
test("says two things, a pause apart", async () => {
  console.log("tick-one");
  await Bun.sleep(1500);
  console.log("tick-two");
});
`,
    );
    const script = new URL("../scripts/test-shards.ts", import.meta.url)
      .pathname;
    const child = Bun.spawn(["bun", script, "live.test.ts"], {
      cwd: dir,
      env: { ...process.env, FORGE_CHECK_SHARDS: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let text = "";
    let firstAt = -1;
    const decoder = new TextDecoder();
    const reading = (async () => {
      for await (const chunk of child.stdout) {
        text += decoder.decode(chunk, { stream: true });
        if (firstAt < 0 && text.includes("tick-one"))
          firstAt = performance.now();
      }
    })();
    const code = await child.exited;
    const ended = performance.now();
    await reading;
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(firstAt).toBeGreaterThan(0);
    // The first line reached us while the test was still asleep.
    expect(ended - firstAt).toBeGreaterThan(1000);
    expect(text).toContain("tick-two");
    expect(text).toContain("── shard 1/1: live.test.ts");
    expect(text).toMatch(/── shard 1\/1 done \(exit 0, [\d.]+s\)/);
  }, 30_000);
});

describe("the gate audit before any shard", () => {
  const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
  const listed = presentTests();
  const git = (dir: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode;
  // `stopAt`: kill the runner once stderr carries it. The audit and the slice
  // banner come before any bun test spawns; what runs after them is the
  // machine's load, not the code under test.
  const run = async (
    extra: string[],
    args: string[],
    drop: string[] = [],
    commit = false,
    stopAt?: string,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "forge-audit-"));
    mkdirSync(join(dir, "test"));
    for (const file of listed) if (!drop.includes(file)) writeFileSync(join(dir, file), "");
    if (commit) {
      expect(git(dir, "init", "-q")).toBe(0);
      expect(git(dir, "add", "-A")).toBe(0);
      expect(git(dir, "commit", "-qm", "base")).toBe(0);
    }
    for (const file of extra) writeFileSync(join(dir, file), "");
    if (commit) {
      expect(git(dir, "add", "-A")).toBe(0);
      expect(git(dir, "commit", "-qm", "add a test")).toBe(0);
    }
    const started = performance.now();
    const child = Bun.spawn(["bun", script, ...args], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const watch = async (stream: ReadableStream<Uint8Array>) => {
      let text = "";
      for await (const chunk of stream) {
        text += new TextDecoder().decode(chunk);
        if (stopAt !== undefined && text.includes(stopAt)) child.kill();
      }
      return text;
    };
    const [out, err] = await Promise.all([new Response(child.stdout).text(), watch(child.stderr)]);
    const code = await child.exited;
    rmSync(dir, { recursive: true, force: true });
    return { code, out, err, ms: performance.now() - started };
  };

  test("a stale exclusion is refused by name, last line, nothing spawned", async () => {
    const gone = EXCLUDED[0]!.file;
    for (const args of [["--gate"], ["--tier", "fast", "--diff", "a..b"]]) {
      const got = await run([], args, [gone]);
      expect(got.code).toBe(2);
      const last = got.err.trim().split("\n").pop()!;
      expect(last).toBe(`test-shards: ${gone}: fix its EXCLUDED entry in scripts/gate.ts`);
      expect(got.out + got.err).not.toContain("start ");
      expect(got.out).not.toContain("── shard");
      expect(got.ms).toBeLessThan(1000);
    }
  });

  test("a new file is in the gate with no list naming it, and explicit files are not audited", async () => {
    // One slice holds every file, so the count includes the new one; a shard
    // per file would outgrow the three digits a shard spec allows.
    const all = String(gateFiles().length + 1);
    const got = await run(["test/zz-new.test.ts"], ["--gate", "--shard", "1/1"], [], false, "matrix slice");
    expect(got.err).not.toContain("EXCLUDED");
    expect(got.out).toContain(`matrix slice 1/1 (${all} of ${all} files)`);
    const explicit = await run(["test/zz-new.test.ts"], ["test/zz-new.test.ts"], [listed[0]!], false, "test-shards: 1 files");
    expect(explicit.err).not.toContain("EXCLUDED");
  }, 30_000);

  test("a pull that only adds test/x.test.ts is gated on it (#2037)", async () => {
    const got = await run(["test/zz-new.test.ts"], ["--tier", "fast", "--diff", "HEAD~1..HEAD"], [], true);
    expect(got.err).not.toContain("EXCLUDED");
    expect(got.out).toContain("for 1 changed");
    expect(got.out).toContain("  test/zz-new.test.ts: changed\n");
  }, 30_000);

  test("a pull no test reaches is green with nothing to run, not a usage error (#3579)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-audit-"));
    mkdirSync(join(dir, "test"));
    for (const file of listed) writeFileSync(join(dir, file), "");
    writeFileSync(join(dir, "impact.json"), JSON.stringify(Object.fromEntries(listed.map((f) => [f, []]))));
    expect(git(dir, "init", "-q")).toBe(0);
    expect(git(dir, "add", "-A")).toBe(0);
    expect(git(dir, "commit", "-qm", "base")).toBe(0);
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "test-times.json"), "{}\n");
    expect(git(dir, "add", "-A")).toBe(0);
    expect(git(dir, "commit", "-qm", "a table only")).toBe(0);
    const child = Bun.spawn(["bun", script, "--tier", "fast", "--diff", "HEAD~1..HEAD"], {
      cwd: dir,
      env: { ...process.env, FORGE_CHECK_IMPACT: "impact.json" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    rmSync(dir, { recursive: true, force: true });
    expect(out).toContain(`0 of ${gateFiles().length} files for 1 changed`);
    expect(out).toContain("test-shards: the change reaches no tests; nothing to run");
    expect(err).not.toContain("name the test files");
    expect(code).toBe(0);
  }, 30_000);
});

describe("the gate audit alone, first in the check", () => {
  const script = new URL("../scripts/gate.ts", import.meta.url).pathname;
  const listed = presentTests();
  // The check sets FORGE_CHECK_BASE; the scratch dir is no repo, so it has none.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "FORGE_CHECK_BASE"));
  const run = async (extra: string[], drop: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "forge-gate-"));
    mkdirSync(join(dir, "test"));
    for (const file of [...listed, ...extra]) if (!drop.includes(file)) writeFileSync(join(dir, file), "");
    const child = Bun.spawn(["bun", script], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const err = await new Response(child.stderr).text();
    const code = await child.exited;
    rmSync(dir, { recursive: true, force: true });
    return { code, err };
  };

  test("a stale exclusion fails it by name; a new unlisted file passes", async () => {
    const gone = EXCLUDED[0]!.file;
    const red = await run([], [gone]);
    expect(red.code).toBe(2);
    expect(red.err.trim().split("\n").pop()).toBe(
      `gate: ${gone}: fix its EXCLUDED entry in scripts/gate.ts`,
    );
    const green = await run(["test/zz-new.test.ts"]);
    expect(green.code).toBe(0);
    // The scratch dir is no git repo, so the pin check says it had no base.
    expect(green.err).toBe("gate: no base to compare to (set FORGE_CHECK_BASE): migration pins not checked\n");
  }, 30_000);
});

describe("a failing file is run once more alone", () => {
  const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
  const dir = "test/fixtures";
  // Heavy by bytes, so the splitter gives it a shard of its own and the
  // other fixtures share the second one. Written here, not committed.
  const scratch = mkdtempSync(join(tmpdir(), "shard-filler-"));
  const filler = join(scratch, "shard-filler.test.ts");
  writeFileSync(filler, `import { test } from "bun:test";\ntest("filler", () => {});\n// ${"padding ".repeat(4000)}\n`);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  // The split must not follow the host: pin the count and the cell's CPUs, and
  // drop any FORGE_CHECK_* the surrounding gate exported (#2726).
  const env = { ...process.env, FORGE_CHECK_SHARDS: "2", FORGE_CELL_CPUS: "4" } as Record<string, string | undefined>;
  for (const name of Object.keys(env)) if (name.startsWith("FORGE_CHECK_") && name !== "FORGE_CHECK_SHARDS") delete env[name];
  const run = async (names: string[]) => {
    const child = Bun.spawn(
      ["bun", script, ...names.map((name) => (name === "filler" ? filler : `${dir}/shard-${name}.test.ts`))],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      },
    );
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, out, err };
  };

  test("red only beside another file: the shard is green and the tail names it", async () => {
    // filler is heavy by bytes, so poison and victim share the other shard.
    const got = await run(["filler", "poison", "victim"]);
    expect(got.out).toContain("fails only beside others: test/fixtures/shard-victim.test.ts (shard-mates: none)");
    expect(got.code).toBe(0);
  }, 30_000);

  test("red alone too: it stays red", async () => {
    const got = await run(["filler", "poison", "victim", "broken"]);
    expect(got.out).toContain("fails only beside others: test/fixtures/shard-victim.test.ts (shard-mates: test/fixtures/shard-broken.test.ts)");
    expect(got.code).toBe(1);
    expect(got.out).toContain("(fail) broken");
  }, 30_000);

  test("one file fails beside others and another errors: the shard stays red", async () => {
    const got = await run(["filler", "poison", "victim", "errors"]);
    expect(got.code).toBe(1);
    expect(got.out).not.toContain("fails only beside others");
    expect(got.out).toContain("boom at load");
  }, 30_000);

  test("a lone file that fails stays red with no verdict line", async () => {
    const got = await run(["broken"]);
    expect(got.code).toBe(1);
    expect(got.out).not.toContain("fails only beside others");
  }, 30_000);
});

describe("every shard runs to the end, and a crashed one once more", () => {
  const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
  const scratch = mkdtempSync(join(tmpdir(), "shard-crash-"));
  // Heavy by bytes, so it runs first and gets a shard of its own.
  const heavyRed = join(scratch, "heavy-red.test.ts");
  writeFileSync(heavyRed, `import { expect, test } from "bun:test";\ntest("heavy red", () => { expect(1).toBe(2); });\n// ${"padding ".repeat(4000)}\n`);
  const filler = join(scratch, "shard-filler.test.ts");
  writeFileSync(filler, `import { test } from "bun:test";\ntest("filler", () => {});\n// ${"padding ".repeat(4000)}\n`);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const run = async (shards: string, files: string[], mark: string) => {
    const env = { ...process.env, FORGE_CHECK_SHARDS: shards, FORGE_CELL_CPUS: "4", SHARD_CRASH_MARK: mark } as Record<string, string | undefined>;
    for (const name of Object.keys(env)) if (name.startsWith("FORGE_CHECK_") && name !== "FORGE_CHECK_SHARDS") delete env[name];
    const child = Bun.spawn(["bun", script, ...files], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, out, err };
  };

  test("a red file does not stop the files after it", async () => {
    // One worker, heaviest first: the red file runs before the green one.
    const got = await run("1", [heavyRed, "test/fixtures/shard-victim.test.ts"], join(scratch, "unused"));
    expect(got.code).toBe(1);
    expect(got.out).toContain("(fail) heavy red");
    expect(got.out).toContain("── shard 2/2: test/fixtures/shard-victim.test.ts");
    expect(got.out).not.toContain("fail-fast");
  }, 30_000);

  test("a crash between tests re-runs its shard once, and the re-run is the verdict", async () => {
    const got = await run("2", [filler, "test/fixtures/shard-crash-once.test.ts", "test/fixtures/shard-victim.test.ts"], join(scratch, "crashed-once"));
    expect(got.out).toContain("crashed outside any test (exit 1); re-running it once. The crashed run:");
    expect(got.out).toContain("  │ error: Cannot use a closed database");
    expect(got.code).toBe(0);
    // Green on the re-run: the crash is named for the check to record as a flake.
    expect(got.err).toMatch(/test-shards: crash flake \d+\/\d+: error: Cannot use a closed database/);
  }, 30_000);

  test("a single worker quotes the crashed run too: no bare error lines, and the re-run is green", async () => {
    const got = await run("1", ["test/fixtures/shard-crash-once.test.ts", "test/fixtures/shard-victim.test.ts"], join(scratch, "crashed-serial"));
    expect(got.out).toContain("crashed outside any test (exit 1); re-running it once. The crashed run:");
    expect(got.out).toContain("  │ error: Cannot use a closed database");
    const bare = got.out.split("\n").filter((line) => !line.startsWith("  │ "));
    expect(bare.some((line) => line.includes("Cannot use a closed database"))).toBe(false);
    expect(bare.some((line) => line.includes("# Unhandled error"))).toBe(false);
    expect(got.code).toBe(0);
  }, 30_000);

  test("only CRASH_RERUNS crashed shards are re-run; the next stays red unre-run", async () => {
    const crashing = [1, 2, 3, 4].map((n) => {
      const file = join(scratch, `crash-${n}.test.ts`);
      writeFileSync(file, `throw new Error("boom at load ${n}");\n`);
      return file;
    });
    const got = await run("4", crashing, join(scratch, "unused"));
    expect(got.out.split("re-running it once").length - 1).toBe(CRASH_RERUNS);
    expect(got.code).toBe(1);
  }, 60_000);

  test("a crash that happens again stays red", async () => {
    const got = await run("2", [filler, "test/fixtures/shard-errors.test.ts", "test/fixtures/shard-victim.test.ts"], join(scratch, "unused"));
    expect(got.out).toContain("re-running it once");
    expect(got.out).toContain("boom at load");
    expect(got.code).toBe(1);
  }, 30_000);
});

describe("a fixture suite in six shards (#7617)", () => {
  const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "shards-fixture-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  const run = async (
    dir: string,
    shards: string,
    names: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; out: string; stdout: string }> => {
    const child = Bun.spawn(["bun", script, ...names], {
      cwd: dir,
      env: { ...process.env, FORGE_CHECK_SHARDS: shards, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    return { code, out: stdout + err, stdout };
  };
  const passing = (n: number): string =>
    `import { test } from "bun:test";\ntest("passes ${n}", () => {});\n`;
  /** The files named on the `── shard N/M…: files` lines, in the order shards ran. */
  const finished = (stdout: string): string[] =>
    [...stdout.matchAll(/^── shard \d+\/\d+(?: \(exit \d+, [\d.]+s\))?: (.*)$/gm)].map((m) => m[1]!);

  test("twelve files in six shards: the plan has six slices and each file runs exactly once", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `s${i}.test.ts`);
    const dir = fixture(Object.fromEntries(names.map((name, i) => [name, passing(i)])));
    const six = await run(dir, "6", names);
    rmSync(dir, { recursive: true, force: true });
    expect(six.code).toBe(0);
    expect(six.out).toContain("12 files in 6 shards");
    expect(six.out.match(/test-shards: start \d+\/6 /g)?.length).toBe(6);
    const ran = finished(six.stdout).flatMap((line) => line.split(" "));
    for (const name of names) expect(ran.filter((file) => file === name).length).toBe(1);
    expect(six.out).toMatch(/Ran 12 tests across 12 files/);
  }, 60_000);

  test("a failure in any shard reds the run and names the test", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`ok${i}.test.ts`] = passing(i);
    files["bad.test.ts"] = `import { test, expect } from "bun:test";\ntest("the broken one", () => { expect(1).toBe(2); });\n`;
    const dir = fixture(files);
    const got = await run(dir, "3", Object.keys(files));
    rmSync(dir, { recursive: true, force: true });
    expect(got.code).not.toBe(0);
    expect(got.out).toContain("(fail) the broken one");
  }, 60_000);

  test("each shard gets its own empty FORGE_APP_DATA and TMPDIR, removed after", async () => {
    const probe = (n: number): string =>
      `import { test, expect } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
test("probe ${n}", () => {
  const data = process.env.FORGE_APP_DATA!;
  expect(readdirSync(data)).toEqual([]);
  expect(readdirSync(tmpdir())).toEqual([]);
  writeFileSync(data + "/mark", "${n}");
  console.log("PROBE-DATA " + data + " PROBE-TMP " + tmpdir());
});
`;
    const names = ["p0.test.ts", "p1.test.ts", "p2.test.ts"];
    const dir = fixture(Object.fromEntries(names.map((name, i) => [name, probe(i)])));
    const root = mkdtempSync(join(tmpdir(), "shards-root-"));
    const got = await run(dir, "3", names, { TMPDIR: root, FORGE_APP_DATA: root });
    rmSync(dir, { recursive: true, force: true });
    const seen = [...got.out.matchAll(/PROBE-DATA (\S+) PROBE-TMP (\S+)/g)];
    const leaked = readdirSync(root);
    rmSync(root, { recursive: true, force: true });
    expect(got.code).toBe(0);
    expect(new Set(seen.map((m) => m[1])).size).toBe(3);
    expect(new Set(seen.map((m) => m[2])).size).toBe(3);
    for (const m of seen) expect(m[1]!.startsWith(root)).toBe(true);
    expect(leaked).toEqual([]);
  }, 60_000);

  test("a FORGE_APP_DATA the cell set is nested under, not replaced", async () => {
    const dir = fixture({
      "d.test.ts": `import { test } from "bun:test";\ntest("d", () => { console.log("PROBE-DATA " + process.env.FORGE_APP_DATA); });\n`,
    });
    const data = mkdtempSync(join(tmpdir(), "shards-data-"));
    const got = await run(dir, "1", ["d.test.ts"], { FORGE_APP_DATA: data });
    rmSync(dir, { recursive: true, force: true });
    const leaked = readdirSync(data);
    rmSync(data, { recursive: true, force: true });
    expect(got.code).toBe(0);
    expect(got.out).toContain(`PROBE-DATA ${data}/data-0`);
    expect(leaked).toEqual([]);
  }, 60_000);
});
