/**
 * A COPY of a path `.dockerignore` leaves out fails only when the image is
 * built, after the pull has landed: 0.7.336 and 0.7.337 did not build for it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const lines = (file: string) => readFileSync(join(ROOT, file), "utf8").split("\n");

/** Whether the rules leave `path` out: the last rule naming it or a parent decides. */
function ignored(rules: readonly string[], path: string): boolean {
  let out = false;
  for (const raw of rules) {
    const rule = raw.trim();
    if (rule === "" || rule.startsWith("#")) continue;
    const keep = rule.startsWith("!");
    const name = rule.replace(/^!/, "").replace(/\/$/, "");
    if (path === name || path.startsWith(`${name}/`)) out = !keep;
  }
  return out;
}

const copied = lines("Dockerfile")
  .filter((l) => l.startsWith("COPY ") && !l.includes("--from"))
  .flatMap((l) => l.trim().split(/\s+/).slice(1, -1));

describe("what the Dockerfile copies reaches the build", () => {
  test("it copies something", () => {
    expect(copied.length).toBeGreaterThan(0);
  });

  for (const path of copied)
    test(`${path} exists and .dockerignore lets it through`, () => {
      expect(existsSync(join(ROOT, path))).toBe(true);
      expect(ignored(lines(".dockerignore"), path)).toBe(false);
    });

  // /packs rendered blank in production: the catalog reads packs/ beside src/, and the
  // image carried only src/. Each folder a page reads from outside src/ is copied.
  test("the packs /packs lists are in the image", () => {
    expect(copied).toContain("packs");
  });
});
