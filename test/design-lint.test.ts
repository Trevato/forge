import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classesIn, compare, countFile, documentedClasses, registeredClasses, scan } from "../scripts/design-lint.ts";

/** A DESIGN.md in miniature: the §5 table, a §5d register, and a §6 that names a class too. */
const DESIGN = [
  "## 4. Space",
  "`.spacing-only` is named before §5.",
  "## 5. The component vocabulary",
  "| **button** | `.btn` | in `src/web/ui.ts` |",
  "| **run log** | `pre.run-log` (`.byline.origin-by`) | at `hello.localhost`, `status.reviews` |",
  "### 5d. Page-local classes",
  "- **`pages/x.ts`** — the x page: `.x-card` `.x-wrapped",
  "` `.x-row`",
  "## 6. Keyboard",
  "`.keys-only` is named after §5.",
].join("\n");

describe("design check: nothing added outside the system (#2678)", () => {
  test("the tree is no worse than its baseline", () => {
    const base = JSON.parse(readFileSync("docs/design/baseline.json", "utf8"));
    expect(compare(base, scan("."), readFileSync("docs/DESIGN.md", "utf8"))).toEqual([]);
  });

  test("counts colour literals and off-scale sizes, not on-scale ones", () => {
    expect(countFile("a{color:#fff;background:#a1b2c3;border:1px solid rgba(0,0,0,.1)}")).toEqual({ colour: 3, size: 0 });
    expect(countFile("a{font-size: 13px} b{font-size: 14px} c{font-size: 13.5px} d{font-size: 72px}")).toEqual({ colour: 0, size: 2 });
    expect(countFile("x = /* css */ `a{color: red; border: 1px solid navy; background: var(--card)}`")).toEqual({ colour: 2, size: 0 });
    expect(countFile("a{background:color-mix(in srgb, red 10%, white)} b{background:color-mix(in srgb, var(--x) 12%, transparent)}").colour).toBe(1);
    expect(countFile("a{color:var(--fg)} // issue #2678")).toEqual({ colour: 0, size: 0 });
  });

  test("an issue reference in a comment is not a colour; the same digits in code are", () => {
    expect(countFile("// the feed (#599), whatever the mode (#625)\nx = 1;").colour).toBe(0);
    expect(countFile("/**\n * Who may fetch a picture (#727, #738).\n */\nx = 1;").colour).toBe(0);
    expect(countFile("a{color:#999}").colour).toBe(1);
    expect(countFile('const u = "https://x.test/#abc";').colour).toBe(1);
  });

  test("finds the classes a css template defines, and only those", () => {
    const text = "const x = a.ts; const css = /* css */ `.btn:hover, .card > .row-title { color: red }\n.new-thing { top: 0.5px }`; foo.bar";
    expect(classesIn(text).sort()).toEqual(["btn", "card", "new-thing", "row-title"]);
  });

  test("§5 names a class in a code span, as a selector, wrapped or not — and only §5 does (#2700)", () => {
    expect(documentedClasses(DESIGN)).toEqual(["btn", "byline", "origin-by", "run-log", "x-card", "x-row", "x-wrapped"]);
    expect(registeredClasses(DESIGN)).toEqual(["x-card", "x-row", "x-wrapped"]);
    expect(documentedClasses("## 4. Space\n`.a`")).toEqual([]);
  });

  test("fails a pull that adds a colour, a size or a component", () => {
    const base = { files: { "src/web/x.ts": { colour: 1, size: 1 } } };
    const now = { ...base, classes: ["btn", "run-log", "x-card", "x-row", "x-wrapped"] };
    expect(compare(base, now, DESIGN)).toEqual([]);
    expect(compare(base, { ...now, files: { "src/web/x.ts": { colour: 0, size: 0 } } }, DESIGN)).toEqual([]);
    expect(compare(base, { ...now, files: { "src/web/x.ts": { colour: 2, size: 1 } } }, DESIGN)).toHaveLength(1);
    expect(compare(base, { ...now, files: { "src/web/y.ts": { colour: 0, size: 1 } } }, DESIGN)).toHaveLength(1);
    expect(compare(base, { ...now, classes: [...now.classes, "gizmo"] }, DESIGN)[0]).toContain(".gizmo");
    // Named outside §5 is not named: §4 and §6 are not the vocabulary.
    expect(compare(base, { ...now, classes: [...now.classes, "keys-only", "spacing-only"] }, DESIGN)).toHaveLength(2);
  });

  test("fails a register entry whose last rule is gone, so §5d only shrinks (#2700)", () => {
    const base = { files: {} };
    const problems = compare(base, { files: {}, classes: ["btn", "x-card", "x-wrapped"] }, DESIGN);
    expect(problems).toEqual([".x-row: no stylesheet defines it any more — strike it from docs/DESIGN.md §5d"]);
  });

  test("every class the stylesheets define is one DESIGN.md §5 names (#2700)", () => {
    const named = new Set(documentedClasses(readFileSync("docs/DESIGN.md", "utf8")));
    expect(scan(".").classes.filter((k) => !named.has(k))).toEqual([]);
  });
});
