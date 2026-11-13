/**
 * A release whose tree covers the page is refused before the swap (#11916):
 * `preflightRelease` runs the covered-page rule (#11831) over the candidate's
 * `src/web` in process, names the rule and the file, and never starts the
 * tree's own `--preflight`. Today's tree passes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coveredPage, preflightRelease } from "../src/release/checkout.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "preflight-covered-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in tree whose `--preflight` passes and leaves a mark that it ran. */
function tree(name: string, css: string): { dir: string; ran: string } {
  const dir = join(root, name);
  const ran = join(dir, "ran");
  mkdirSync(join(dir, "src", "web", "style"), { recursive: true });
  writeFileSync(
    join(dir, "src", "main.ts"),
    `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "1"); console.log("preflight ok: stand-in");\n`,
  );
  writeFileSync(join(dir, "src", "web", "style", "layer.ts"), `export const layer = /* css */ \`\n${css}\n\`;\n`);
  return { dir, ran };
}

describe("preflight: the covered-page rule (#11916)", () => {
  test("an always-on full-screen fixed layer is refused with the rule and the file, before the tree runs", async () => {
    const { dir, ran } = tree("covered", "@media (max-width: 719px) {\n  .sheet { display: block; position: fixed; inset: 0; }\n}");
    const v = await preflightRelease(dir, join(root, "data"));
    expect(v.ok).toBe(false);
    expect(v.line).toContain("covered-page rule");
    expect(v.line).toContain("src/web/style/layer.ts:");
    expect(v.line).toContain(".sheet");
    expect(v.line.split("\n")).toHaveLength(1);
    expect(existsSync(ran)).toBe(false);
  });

  test("the same layer keyed on the open state passes and the tree's own preflight runs", async () => {
    const { dir, ran } = tree("open", ".sheet[open] { display: block; position: fixed; inset: 0; }");
    const v = await preflightRelease(dir, join(root, "data"));
    expect(v).toEqual({ ok: true, line: "preflight ok: stand-in" });
    expect(existsSync(ran)).toBe(true);
  });

  test("today's tree is not covered", () => {
    expect(coveredPage(join(import.meta.dir, ".."))).toEqual({ ok: true, line: "no page covered" });
  });
});
