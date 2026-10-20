import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
type Deps = Record<string, string>;
type Manifest = Partial<Record<(typeof kinds)[number], Deps>>;
const kinds = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const;

const pkg: Manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// bun.lock is JSONC: plain JSON plus trailing commas.
const lock = JSON.parse(
  readFileSync(join(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1"),
) as { workspaces: Record<string, Manifest> };
const locked = lock.workspaces[""] ?? {};

test("the forge has no runtime dependencies", () => {
  for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const names = Object.keys(pkg[kind] ?? {});
    expect(names.length === 0 ? "" : `${kind}: ${names.join(", ")}`).toBe("");
  }
});

test("bun.lock names the same packages as package.json", () => {
  for (const kind of kinds) {
    const want = pkg[kind] ?? {};
    const have = locked[kind] ?? {};
    for (const name of Object.keys(want))
      expect(name in have ? "" : `${kind}: ${name} is in package.json but not bun.lock`).toBe("");
    for (const name of Object.keys(have))
      expect(name in want ? "" : `${kind}: ${name} is in bun.lock but not package.json`).toBe("");
    for (const [name, range] of Object.entries(want))
      expect(have[name]).toBe(range);
  }
});
