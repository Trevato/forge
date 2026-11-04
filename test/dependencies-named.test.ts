/**
 * "Less is better" gets its enforcer (#8740): every package in package.json
 * has one line of why in README.md's Dependencies section, and the section
 * names no package that has left. Pure file reads.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The package names a README's `## Dependencies` section justifies: each `- \`name\` — why` bullet. */
export function justified(readme: string): Map<string, string> {
  const start = readme.indexOf("\n## Dependencies\n");
  if (start < 0) return new Map();
  const rest = readme.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  const out = new Map<string, string>();
  for (const m of section.matchAll(/^- `([^`]+)` — (.+)$/gm)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const packages = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
const lines = justified(readFileSync(join(ROOT, "docs/REFERENCE.md"), "utf8"));

test("every package in package.json has its line of why in the README", () => {
  const missing = packages.filter((name) => !lines.get(name));
  expect(missing, `README.md's Dependencies section does not justify: ${missing.join(", ")}`).toEqual([]);
});

test("the README justifies no package package.json no longer has", () => {
  const stale = [...lines.keys()].filter((name) => !packages.includes(name));
  expect(stale, `README.md's Dependencies section names packages not in package.json: ${stale.join(", ")}`).toEqual([]);
});

test("a package with no line is caught, and the section ends at the next heading", () => {
  const readme = "# R\n## Dependencies\n\n- `a` — why a.\n- `b` —\n## Next\n- `c` — not here.\n";
  const found = justified(readme);
  expect([...found.keys()]).toEqual(["a"]);
  expect(justified("# R\nno section\n").size).toBe(0);
});
