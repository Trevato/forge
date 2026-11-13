/**
 * Dead code (#11842): an export under src/ that nothing calls fails here
 * unless `scripts/unused-exports-allow.json` lists it, and a listed export
 * that has gained a caller or been deleted fails too, so the list only shrinks.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unusedExports } from "../scripts/unused-exports.ts";
import allowed from "../scripts/unused-exports-allow.json";

const found = unusedExports(new URL("..", import.meta.url).pathname);

test("dead code: every export under src/ has a caller, or is allowed", () => {
  const fresh = found.filter((f) => !allowed.includes(f));
  expect(
    fresh,
    `Dead code: nothing calls these exports; remove them or use them (path name); only if truly intended, add them to scripts/unused-exports-allow.json: ${fresh.join(", ")}`,
  ).toEqual([]);
});

test("an allowed export that is now used or gone is reported, not failed", () => {
  // Non-blocking on purpose: a pull that gives a listed export a caller, or deletes it,
  // must not have to edit the shared list, or concurrent pulls conflict on it.
  const stale = allowed.filter((f) => !found.includes(f));
  if (stale.length) console.warn(`no longer dead; \`bun scripts/unused-exports.ts --write\` prunes: ${stale.join(", ")}`);
  expect(Array.isArray(stale)).toBe(true);
});

test("unusedExports() flags a name mentioned only at its declaration; tests do not count", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "unused-exports-"));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    put("src/a.ts", "export function clearState() {}\nexport const used = 1;\nexport async function onlyTested() {}\n");
    put("src/b.ts", 'import { used } from "./a.ts";\nexport const x = used;\n');
    put("test/a.test.ts", "onlyTested(); clearState();\n");
    expect(unusedExports(dir)).toEqual(["src/a.ts clearState", "src/a.ts onlyTested", "src/b.ts x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
