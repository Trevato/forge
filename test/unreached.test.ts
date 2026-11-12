/**
 * A module under src/ that only tests import is not reachable (#6500): it
 * fails here unless `scripts/unreached-allow.json` lists it, and a listed
 * file that has become reached fails too, so the list only shrinks.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ENTRIES, unreached } from "../scripts/unreached.ts";
import allowed from "../scripts/unreached-allow.json";

const root = new URL("..", import.meta.url).pathname;
const found = unreached(root);

test("every module under src/ is imported by another, or allowed", () => {
  const fresh = found.filter((f) => !allowed.includes(f));
  expect(fresh, `imported by nothing under src/: ${fresh.join(", ")}; call it from the app or it is not done`).toEqual([]);
});

test("an allowed module that has become reached leaves the list", () => {
  const stale = allowed.filter((f) => !found.includes(f));
  expect(stale, `now reached, remove from scripts/unreached-allow.json: ${stale.join(", ")}`).toEqual([]);
});

test("every declared entry point exists", () => {
  const missing = ENTRIES.filter((e) => !existsSync(join(root, e)));
  expect(missing, `entry points that no longer exist, rename them in scripts/unreached.ts: ${missing.join(", ")}`).toEqual([]);
});

test("unreached() follows imports from the entries and scripts, and nothing else", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "unreached-"));
  const put = (path: string, text = "export {};\n") => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    put("src/main.ts", 'import { a } from "./a.js";\nimport "./side.ts";\n');
    put("src/a.ts", 'export const load = () => import(\n  "./b"\n);\n');
    put("src/b/index.ts", "export const t = () => import(`./tpl`);\n");
    put("src/b/tpl.ts");
    put("src/side.ts", 'Bun.build({ entrypoints: [Bun.fileURLToPath(new URL("./entry.ts", import.meta.url))] });\n');
    put("src/entry.ts");
    put("src/c.ts", 'const notAnEntry = new URL("./g.ts", "https://x");\n');
    put("src/g.ts");
    put("src/d.ts", 'import "./c.ts";\n');
    put("src/e.ts");
    put("src/a.test.ts", 'import "./e.ts";\n');
    put("src/types.d.ts");
    put("src/core/migrations/001.ts");
    put("src/f.ts");
    put("src/orphan.ts");
    put("scripts/tool.ts", 'const { f } = await import("../src/f.ts");\n');
    expect(unreached(dir)).toEqual(["src/c.ts", "src/d.ts", "src/e.ts", "src/g.ts", "src/orphan.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
