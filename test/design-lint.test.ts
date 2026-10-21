import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { areaFiles, classesIn, compare, countFile, documentedClasses, locate, registeredClasses, scan, webCss } from "../scripts/design-lint.ts";

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

// One walk of the tree serves both tests that read it, and a loaded check machine
// gets a timeout far past the walk's cost: the verdict is the code's, not the clock's.
let tree: ReturnType<typeof scan> | undefined;
const treeNow = () => (tree ??= scan("."));
const SLOW = 60_000;

describe("design check: nothing added outside the system (#2678)", () => {
  test("the tree is no worse than its baseline", () => {
    const base = JSON.parse(readFileSync("docs/design/baseline.json", "utf8"));
    expect(compare(base, treeNow(), readFileSync("docs/DESIGN.md", "utf8"), areaFiles("."))).toEqual([]);
  }, SLOW);

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

  test("counts the website-spec stylesheet rules (#2939)", () => {
    const css = (c: string) => webCss("x = /* css */ `" + c + "`");
    expect(css("a{transition:color .2s} @keyframes s{}").motion).toBe(2);
    expect(css("a{transition:color .2s} @media (prefers-reduced-motion: reduce){a{transition:none}}").motion).toBe(0);
    expect(css("a:focus{outline:2px solid var(--fg)}")).toMatchObject({ forced: 1, focus: 1 });
    expect(css("a:focus-visible{outline:2px solid var(--fg)} @media (forced-colors: active){a:focus-visible{outline-color:Highlight}}")).toMatchObject({ forced: 0, focus: 0 });
    expect(css("input{font-size:14px} textarea{font-size:16px} p{font-size:12px}").input).toBe(1);
    expect(css("button{height:20px} .btn{min-width:24px} div{height:8px} a{width:10px}").target).toBe(2);
  });

  test("a pull may not raise a website-spec count, and may lower it (#2939)", () => {
    const base = { files: { "src/web/x.ts": { colour: 0, size: 0, motion: 2 } } };
    const now = { classes: ["btn", "run-log", "x-card", "x-row", "x-wrapped"], files: { "src/web/x.ts": { colour: 0, size: 0, motion: 3 } } };
    expect(compare(base, now, DESIGN)[0]).toContain("prefers-reduced-motion");
    expect(compare(base, { ...now, files: { "src/web/x.ts": { colour: 0, size: 0, motion: 1 } } }, DESIGN)).toEqual([]);
    expect(compare(base, { ...now, files: { "src/web/y.ts": { colour: 0, size: 0, target: 1 } } }, DESIGN)[0]).toContain("WCAG 2.5.8");
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
    const named = new Set(documentedClasses(readFileSync("docs/DESIGN.md", "utf8"), areaFiles(".")));
    expect(treeNow().classes.filter((k) => !named.has(k))).toEqual([]);
  }, SLOW);

  test("a red names the file:line, the literal and the token to use (#4063)", () => {
    const text = "const css = /* css */ `\n.card{\n  color: #abc;\n  font-size: 13.5px;\n}`;";
    expect(locate(text)).toEqual([
      { line: 3, kind: "colour", text: "#abc", use: expect.stringContaining("var(--fg)") },
      { line: 4, kind: "size", text: "font-size: 13.5px", use: expect.stringContaining("13px") },
    ]);
    const base = { files: {} };
    const now = { classes: ["btn", "run-log", "x-card", "x-row", "x-wrapped"], files: { "src/web/x.ts": countFile(text) }, found: { "src/web/x.ts": locate(text) } };
    const [colour, size] = compare(base, now, DESIGN);
    expect(colour).toContain("src/web/x.ts:3  #abc  →  use var(--fg)");
    expect(size).toContain("src/web/x.ts:4  font-size: 13.5px  →  use 13px");
  });

  test("an unknown class says where to name it, and what is alike (#4063)", () => {
    const now = { files: {}, classes: ["btn", "run-log", "x-card", "x-row", "x-wrapped", "btn-big"] };
    const [msg] = compare({ files: {} }, now, DESIGN);
    expect(msg).toContain("docs/design/areas/<area>.md");
    expect(msg).toContain(".btn");
  });

  test("two pulls naming different components in their own area files do not touch DESIGN.md (#4063)", () => {
    const now = { files: {}, classes: ["btn", "run-log", "x-card", "x-row", "x-wrapped", "gizmo", "widget"] };
    expect(compare({ files: {} }, now, DESIGN)).toHaveLength(2);
    expect(compare({ files: {} }, now, DESIGN, ["`.gizmo` a gizmo"])).toHaveLength(1);
    expect(compare({ files: {} }, now, DESIGN, ["`.gizmo` a gizmo", "`.widget` a widget"])).toEqual([]);
  });

  test("a named colour is reported at its own line, repeats included (#4063)", () => {
    const text = "const css = /* css */ `\na{color: red}\nb{color: blue}\nc{color: red}`;";
    expect(locate(text).map((f) => f.line)).toEqual([2, 3, 4]);
  });

  test("the areas README is not vocabulary (#4063)", () => {
    const readme = readFileSync("docs/design/areas/README.md", "utf8");
    const own = namedFromReadme(readme);
    expect(own.length).toBeGreaterThan(0);
    const read = areaFiles(".").join("\n");
    for (const k of own) expect(read).not.toContain("`." + k + "`");
  });
});

const namedFromReadme = (text: string) => documentedClasses("## 5. x\n" + text);
