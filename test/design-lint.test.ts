import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classesIn, compare, countFile, scan } from "../scripts/design-lint.ts";

describe("design check: nothing added outside the system (#2678)", () => {
  test("the tree is no worse than its baseline", () => {
    const base = JSON.parse(readFileSync("docs/design/baseline.json", "utf8"));
    expect(compare(base, scan("."))).toEqual([]);
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

  test("fails a pull that adds a colour, a size or a component", () => {
    const base = { files: { "src/web/x.ts": { colour: 1, size: 1 } }, classes: ["btn"] };
    expect(compare(base, base)).toEqual([]);
    expect(compare(base, { files: { "src/web/x.ts": { colour: 0, size: 0 } }, classes: ["btn"] })).toEqual([]);
    expect(compare(base, { ...base, files: { "src/web/x.ts": { colour: 2, size: 1 } } })).toHaveLength(1);
    expect(compare(base, { ...base, files: { "src/web/y.ts": { colour: 0, size: 1 } } })).toHaveLength(1);
    expect(compare(base, { ...base, classes: ["btn", "gizmo"] })[0]).toContain(".gizmo");
  });
});
