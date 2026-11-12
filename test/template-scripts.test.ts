/**
 * scripts/take-template.ts and scripts/birth-check.ts (#10305): the only
 * checks that a template change still bundles and still boots.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bakedTemplate } from "../src/apps/template.ts";

setDefaultTimeout(60_000);

let root: string;
const git = (dir: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });

async function checkout(name: string, extra: Record<string, Uint8Array | string> = {}): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const all: Record<string, string | Uint8Array> = {};
  for (const f of bakedTemplate().files) all[f.path] = typeof f.content === "string" ? f.content : "";
  Object.assign(all, extra);
  for (const [p, c] of Object.entries(all)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "t");
  return dir;
}

const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", script), ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

beforeAll(async () => {
  root = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "tpl-scripts-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

test("take-template records HEAD as a pinned commit and the tracked files", async () => {
  const dir = await checkout("take");
  const out = join(root, "take.json");
  const r = run("take-template.ts", [dir], { FORGE_TEMPLATE_OUT: out });
  expect(r.exitCode).toBe(0);
  const bundle = JSON.parse(await Bun.file(out).text());
  expect(bundle.commit).toBe(git(dir, "rev-parse", "HEAD").stdout.toString().trim());
  expect(bundle.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(bundle.pinned).toBe(true);
  expect(Object.keys(bundle.files).sort()).toEqual(bakedTemplate().files.map((f) => f.path).sort());
});

test("take-template refuses a binary file and a checkout without template.json", async () => {
  const bin = await checkout("bin", { "icon.png": new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00]) });
  const out = join(root, "bin.json");
  const r = run("take-template.ts", [bin], { FORGE_TEMPLATE_OUT: out });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("icon.png");
  expect(await Bun.file(out).exists()).toBe(false);
  const none = join(root, "none");
  await mkdir(none);
  git(none, "init", "-q");
  await writeFile(join(none, "a.txt"), "x");
  git(none, "add", "-A");
  git(none, "commit", "-q", "-m", "t");
  expect(run("take-template.ts", [none], { FORGE_TEMPLATE_OUT: join(root, "none.json") }).exitCode).toBe(1);
});

test("birth-check boots the born app and exits 0; a template that does not boot exits 1", async () => {
  const good = await checkout("good");
  const ok = run("birth-check.ts", [good], { TMPDIR: root });
  expect(ok.stdout.toString()).toContain("booted");
  expect(ok.exitCode).toBe(0);
  const bad = await checkout("bad", { "src/server.ts": "throw new Error('does not boot');\n" });
  expect(run("birth-check.ts", [bad], { TMPDIR: root }).exitCode).toBe(1);
});
