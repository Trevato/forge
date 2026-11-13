import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "copyfiles-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const script = join(import.meta.dir, "..", "scripts", "copy-app-files.ts");
async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORGE_APP_DATA: "", ...env },
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

function source(): string {
  const d = tmp();
  mkdirSync(join(d, "up"));
  writeFileSync(join(d, "up/a.txt"), "hello");
  return d;
}

test("exit 0 and the manifest when the copy matches", async () => {
  const to = join(tmp(), "data");
  const r = await run([source(), to]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("manifests match");
  expect(r.out).toContain("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  5  up/a.txt");
});

test("the target defaults to FORGE_APP_DATA", async () => {
  const to = join(tmp(), "data");
  const r = await run([source()], { FORGE_APP_DATA: to });
  expect(r.code).toBe(0);
});

test("exit 1 and an EXTRA line when the target holds other files", async () => {
  const to = tmp();
  writeFileSync(join(to, "other.db"), "x");
  const r = await run([source(), to]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("EXTRA other.db");
  expect(r.out).toContain("NOT PROVEN");
});

test("exit 1 when a symlink was left behind, 0 with --allow-skips", async () => {
  const from = source();
  symlinkSync("/etc/passwd", join(from, "link"));
  const r = await run([from, join(tmp(), "data")]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("SKIPPED (not a regular file, not copied): link");
  expect((await run(["--allow-skips", from, join(tmp(), "data")])).code).toBe(0);
});

test("exit 2 on usage and on a missing directory, with a message and no stack", async () => {
  const usage = await run([]);
  expect(usage.code).toBe(2);
  expect(usage.err).toContain("usage:");
  for (const args of [["--manifest", join(tmp(), "nope")], [join(tmp(), "nope"), tmp()]]) {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.err).not.toContain("    at ");
    expect(r.err.length).toBeGreaterThan(0);
  }
});

test("--manifest prints the manifest alone", async () => {
  const r = await run(["--manifest", source()]);
  expect(r.code).toBe(0);
  expect(r.out).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  5  up/a.txt\n");
});
