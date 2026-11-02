/**
 * The web's static modules are cheap to import (#8311). `style.ts`,
 * `client.ts` and `asset.ts` used to cost 300–450 ms each, not to transpile
 * their template literals but because each reached the whole app graph: the
 * stylesheet read the board's rules from the board page (core, actions, db),
 * and `ui.ts` reached `apps/runtime.ts` twice — once through an import that
 * named only types, which `verbatimModuleSyntax` keeps as a side-effect
 * import, and once for one string constant. Every test file that starts a
 * server paid that before its first test.
 *
 * Each module is imported in a fresh `bun` process and the modules it loaded
 * are read back: none of the three may load the app's data graph again. The
 * guard is the module list, not a clock — a wall-clock bound flakes under the
 * parallel check; a time budget per test belongs to #1242.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { boardCss as boardPageCss } from "../src/web/pages/board.ts";
import { boardCss } from "../src/web/pages/board_style.ts";
import { assetResponse, shellAsset, stylesheetAsset, stylesheetResponse } from "../src/web/asset.ts";
import { css } from "../src/web/style.ts";
import { shellJs } from "../src/web/client.ts";

const ROOT = join(import.meta.dir, "..");
const MODULES = ["src/web/style.ts", "src/web/client.ts", "src/web/asset.ts"];

/** Modules the static web must never pull in: the data graph and the pages.
 * Of `src/apps/` only `env_phrase.ts` (plain words, type-only imports) is allowed, so
 * any path into the apps graph — `runtime.ts`, `data.ts`, … — fails. */
const HEAVY = [
  /^src\/core\//,
  /^src\/db\//,
  /^src\/apps\/(?!env_phrase\.ts$)/,
  /^src\/web\/pages\/board\.ts$/,
  /^src\/web\/layout\.ts$/,
];

function loadedModules(module: string): string[] {
  const script = `
    await import(${JSON.stringify(`./${module}`)});
    const root = process.cwd() + "/";
    const modules = Object.keys(require.cache).filter((k) => k.startsWith(root)).map((k) => k.slice(root.length));
    console.log(JSON.stringify(modules));
  `;
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`importing ${module} failed: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!) as string[];
}

describe("importing the web's static modules", () => {
  for (const module of MODULES) {
    test(`${module} imports without the app's data graph`, () => {
      const modules = loadedModules(module);
      expect(modules).toContain(module);
      expect(modules.filter((m) => HEAVY.some((re) => re.test(m)))).toEqual([]);
    });
  }
});

describe("the served bytes are the modules' own", () => {
  const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");

  test("the board page still exports the very rules the stylesheet serves", () => {
    expect(boardPageCss).toBe(boardCss);
    expect(css).toContain(boardCss);
  });

  test("the stylesheet's address and body hash to the assembled sheet", async () => {
    const asset = stylesheetAsset();
    expect(asset.etag).toBe(`"${sha256(css)}"`);
    const body = await stylesheetResponse(new Request(`http://forge.test${asset.path}`)).text();
    expect(sha256(body)).toBe(sha256(css));
  });

  test("the shell script's address and body hash to the shell", async () => {
    const asset = shellAsset();
    expect(asset.etag).toBe(`"${sha256(shellJs)}"`);
    const body = await assetResponse(new Request(`http://forge.test${asset.path}`), asset).text();
    expect(sha256(body)).toBe(sha256(shellJs));
  });
});
