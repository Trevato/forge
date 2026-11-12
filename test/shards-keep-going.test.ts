/**
 * `scripts/test-shards.ts --keep-going`, the verification after landing
 * (#7786): a red file stops nothing, a file red once and green alone is
 * named flaky and passes, the impact of every green file is written though
 * another is red, and `FORGE_CHECK_ONLY` keeps only the files it names.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAKY_ALONE } from "../src/checks/verify.ts";

const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "shards-keep-going-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "lib.ts"), "export const one = (): number => 1;\n");
  // The heaviest by bytes runs first, so the red is first and the rest still run.
  writeFileSync(
    join(dir, "test", "a.test.ts"),
    `import { test, expect } from "bun:test";\n${"// padding so this file is heaviest\n".repeat(40)}test("red", () => { expect(1).toBe(2); });\n`,
  );
  writeFileSync(
    join(dir, "test", "b.test.ts"),
    `import { test, expect } from "bun:test";\nimport { one } from "../lib.ts";\ntest("green", () => { expect(one()).toBe(1); });\n`,
  );
  // Red the first time it runs, green after: a flake.
  writeFileSync(
    join(dir, "test", "c.test.ts"),
    `import { test, expect } from "bun:test";\nimport { existsSync, writeFileSync } from "node:fs";\nimport { one } from "../lib.ts";\n` +
      `test("flaky", () => { const seen = existsSync("seen"); writeFileSync("seen", ""); expect(seen && one() === 1).toBe(true); });\n`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function shards(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["bun", script, ...args, "test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], {
    cwd: dir,
    env: { ...process.env, FORGE_CHECK_SHARDS: "1", FORGE_CHECK_IMPACT: ".impact.json", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, out: out + err };
}

describe("--keep-going", () => {
  test("every file runs past the red, the flake passes alone, and the green files' impact is written", async () => {
    rmSync(join(dir, "seen"), { force: true });
    const { code, out } = await shards(["--keep-going", "--impact"]);
    expect(code).toBe(1);
    expect(out).not.toContain("fail-fast");
    expect(out).toContain(`${FLAKY_ALONE} test/c.test.ts`);
    expect(out).toContain("Ran 3 tests across 3 files");
    const map = JSON.parse(readFileSync(join(dir, ".impact.json"), "utf8")) as Record<string, unknown>;
    const tests = JSON.stringify(map);
    expect(tests).toContain("test/b.test.ts");
    expect(tests).toContain("test/c.test.ts");
    expect(tests).not.toContain("test/a.test.ts");
  }, 60_000);

  test("without it, a red shard no longer stops the rest (#7788), no lone re-run, and no map is written", async () => {
    rmSync(join(dir, "seen"), { force: true });
    rmSync(join(dir, ".impact.json"), { force: true });
    const { code, out } = await shards(["--impact"]);
    expect(code).toBe(1);
    expect(out).not.toContain("fail-fast");
    expect(out).not.toContain(FLAKY_ALONE);
    expect(out).toContain("Ran 3 tests across 3 files");
    expect(existsSync(join(dir, ".impact.json"))).toBe(false);
  }, 60_000);

  test("FORGE_CHECK_ONLY runs only the files it names", async () => {
    const { code, out } = await shards(["--keep-going"], { FORGE_CHECK_ONLY: "test/b.test.ts,../x.test.ts" });
    expect(code).toBe(0);
    expect(out).toContain("FORGE_CHECK_ONLY keeps 1 of 1 named file(s)");
    expect(out).not.toContain("(fail) red");
  }, 60_000);
});
