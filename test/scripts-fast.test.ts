import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseNames, report } from "../scripts/fast.ts";

test("parseArgs defaults to origin/main and takes --base and --why", () => {
  expect(parseArgs([])).toEqual({ ok: true, base: "origin/main", format: "lines" });
  expect(parseArgs(["--base", "main", "--why"])).toEqual({ ok: true, base: "main", format: "why" });
  expect(parseArgs(["--base=HEAD~3"])).toEqual({ ok: true, base: "HEAD~3", format: "lines" });
});

test("parseArgs refuses flags-as-revisions, repeats and strangers", () => {
  for (const bad of [["--base"], ["--base", "--output=x"], ["--base", "a b"], ["--base", "a", "--base", "b"], ["--nope"]])
    expect(parseArgs(bad).ok).toBe(false);
});

test("parseNames joins outputs, drops blanks, repeats and paths outside the repo", () => {
  expect(parseNames("a.ts\n\nsrc/b.ts\n", "src/b.ts\n../x\n/etc/passwd\ntest/c.test.ts")).toEqual([
    "a.ts",
    "src/b.ts",
    "test/c.test.ts",
  ]);
});

const plan = { files: ["test/a.test.ts"], why: new Map([["test/a.test.ts", "changed"]]) };

test("parseArgs takes one output format", () => {
  expect(parseArgs(["--null"])).toEqual({ ok: true, base: "origin/main", format: "null" });
  expect(parseArgs(["--json", "--why"]).ok).toBe(false);
});

test("report lists files in each format, sentences only in notes", () => {
  expect(report(plan, undefined, "lines")).toEqual({ stdout: "test/a.test.ts\n", notes: [], code: 0 });
  expect(report(plan, undefined, "why").stdout).toBe("test/a.test.ts\tchanged\n");
  expect(report(plan, undefined, "null").stdout).toBe("test/a.test.ts\0");
  expect(JSON.parse(report(plan, undefined, "json").stdout)).toEqual({
    full: null,
    files: [{ file: "test/a.test.ts", why: "changed" }],
  });
});

test("an unbounded diff is exit 2 with nothing on stdout but json", () => {
  for (const format of ["lines", "why", "null"] as const) {
    const out = report(plan, "package.json", format);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.notes[0]).toContain("full tier");
  }
  expect(JSON.parse(report(plan, "package.json", "json").stdout)).toEqual({ full: "package.json", files: [] });
});

test("a diff that reaches no test is exit 3 with nothing on stdout", () => {
  const out = report({ files: [], why: new Map() }, undefined, "lines");
  expect(out).toEqual({ stdout: "", notes: ["fast: the change reaches no test; nothing to run"], code: 3 });
});

// The script itself, against a throwaway repository.
const SCRIPT = new URL("../scripts/fast.ts", import.meta.url).pathname;

function repo(): string {
  const dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "fast-"));
  const git = (...args: string[]): void => {
    const run = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir },
    );
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  };
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src/widget.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/other.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "test/widget.test.ts"), "export {};\n");
  writeFileSync(join(dir, "test/other.test.ts"), "export {};\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "work");
  return dir;
}

function run(dir: string, ...args: string[]): { out: string; err: string; code: number } {
  const env = { ...process.env };
  delete env["FORGE_CHECK_IMPACT"];
  const done = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: dir, env });
  return { out: done.stdout.toString(), err: done.stderr.toString(), code: done.exitCode ?? -1 };
}

test("a changed source file lists the test it names, committed or not, with --why", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "src/widget.ts"), "export const a = 2;\n");
    const plain = run(dir, "--base", "main");
    expect(plain.code).toBe(0);
    expect(plain.out.trim().split("\n")).toEqual(["test/widget.test.ts"]);
    const why = run(dir, "--base", "main", "--why");
    expect(why.out).toContain("test/widget.test.ts\tnamed for src/widget.ts");
    // Untracked counts too.
    writeFileSync(join(dir, "src/other.ts"), "export const b = 2;\n");
    expect(run(dir, "--base", "main").out.trim().split("\n")).toEqual([
      "test/other.test.ts",
      "test/widget.test.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unbounded diff exits 2 with the full-tier line and no file list", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "package.json"), '{"a":1}\n');
    const out = run(dir, "--base", "main");
    expect(out.code).toBe(2);
    expect(out.out).toBe("");
    expect(out.err).toContain("full tier: package.json changed");
    const json = run(dir, "--base", "main", "--json");
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toEqual({ full: "package.json", files: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a base git cannot find exits 2 with a message", () => {
  const dir = repo();
  try {
    const out = run(dir, "--base", "nope");
    expect(out.code).toBe(2);
    expect(out.err).toContain("fast:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean tree and a docs-only diff exit 3 with empty stdout, so `&&` stops bun test", () => {
  const dir = repo();
  try {
    const clean = run(dir, "--base", "main");
    expect([clean.code, clean.out]).toEqual([3, ""]);
    expect(clean.err).toContain("nothing to run");
    writeFileSync(join(dir, "NOTES.md"), "hi\n");
    expect(run(dir, "--base", "main", "--null").code).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--null and --json carry the files without word-splitting", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "src/widget.ts"), "export const a = 2;\n");
    expect(run(dir, "--base", "main", "--null").out).toBe("test/widget.test.ts\0");
    expect(JSON.parse(run(dir, "--base", "main", "--json").out).files[0].file).toBe("test/widget.test.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
