import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, compareManifests, copyWithManifest, manifestText } from "../src/apps/file_manifest.ts";

const made: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "manifest-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(): string {
  const d = tmp();
  mkdirSync(join(d, "up/2024"), { recursive: true });
  writeFileSync(join(d, "a.txt"), "hello");
  writeFileSync(join(d, "up/2024/b.bin"), Buffer.from([0, 1, 2, 255]));
  return d;
}

test("the manifest lists regular files sorted with their sha-256", () => {
  const m = buildManifest(tree());
  expect(m.entries.map((e) => e.path)).toEqual(["a.txt", "up/2024/b.bin"]);
  expect(m.entries[0]!.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  expect(manifestText(m).split("\n")[0]).toBe(`${m.entries[0]!.sha256}  5  a.txt`);
});

test("a copy is proven by both manifests", () => {
  const r = copyWithManifest(tree(), join(tmp(), "data"));
  expect(r.ok).toBe(true);
  expect(r.files).toBe(2);
  expect(r.bytes).toBe(9);
});

test("a symlink is skipped, never followed, and the copy is not proven", () => {
  const from = tree();
  symlinkSync("/etc/passwd", join(from, "link"));
  const r = copyWithManifest(from, join(tmp(), "data"));
  expect(r.skipped).toEqual(["link"]);
  expect(r.diff).toEqual({ missing: [], extra: [], changed: [] });
  expect(r.ok).toBe(false);
  expect(r.target.entries.map((e) => e.path)).not.toContain("link");
  expect(copyWithManifest(from, join(tmp(), "data"), { allowSkips: true }).ok).toBe(true);
});

test("the comparison names missing, changed and extra files", () => {
  const a = buildManifest(tree());
  const bDir = tree();
  writeFileSync(join(bDir, "a.txt"), "HELLO");
  writeFileSync(join(bDir, "new.txt"), "x");
  const b = buildManifest(bDir);
  b.entries = b.entries.filter((e) => e.path !== "up/2024/b.bin");
  expect(compareManifests(a, b)).toEqual({ missing: ["up/2024/b.bin"], extra: ["new.txt"], changed: ["a.txt"] });
});

test("a target inside the source is refused", () => {
  const from = tree();
  expect(() => copyWithManifest(from, join(from, "inside"))).toThrow();
});

test("a target that is a symlink into the source is refused", () => {
  const from = tree();
  const link = join(tmp(), "alias");
  symlinkSync(from, link);
  expect(() => copyWithManifest(from, link)).toThrow();
  expect(() => copyWithManifest(from, join(link, "deeper"))).toThrow();
});

test("a target holding a symlinked directory or file is refused before anything is written", () => {
  const outside = tmp();
  const to = tmp();
  symlinkSync(outside, join(to, "up"));
  expect(() => copyWithManifest(tree(), to)).toThrow(/symlink/);
  expect(existsSync(join(outside, "2024"))).toBe(false);
  expect(existsSync(join(to, "a.txt"))).toBe(false);

  const to2 = tmp();
  writeFileSync(join(outside, "victim"), "keep");
  symlinkSync(join(outside, "victim"), join(to2, "a.txt"));
  expect(() => copyWithManifest(tree(), to2)).toThrow(/symlink/);
  expect(readFileSync(join(outside, "victim"), "utf8")).toBe("keep");
});
