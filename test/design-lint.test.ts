import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { areaFiles, compareLayout, layoutCounts, layoutIn, scanLayout, classesIn, compare, compareQuiet, quiet, scanQuiet, scanCards, scanStranger, strangerWords, STRANGER_FILES, countFile, designText, documentedClasses, locate, loneSentenceCards, registeredClasses, overlay, overlayClassesIn, scanOverlay, scan, sectionLinks, webCss } from "../scripts/design-lint.ts";

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
    expect(compare(base, treeNow(), designText("."), areaFiles("."))).toEqual([]);
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

  test("§5d's one-class-per-line sub-list reads as the same set as the inline run (#4888)", () => {
    const inline = [
      "## 5. The component vocabulary",
      "### 5d. Page-local classes",
      "- **`style/base.ts`** — the shell: `.bar` `.bare` `.foot`",
      "  A `.field` inside a `.bar` drops its margin",
      "- **`pages/x.ts`** — the x page. Classes: `.x-card` `.x-row`",
      "## 6. Keyboard",
    ].join("\n");
    const listed = [
      "## 5. The component vocabulary",
      "### 5d. Page-local classes",
      "- **`style/base.ts`** — the shell:",
      "  - `.bar`",
      "  - `.bare`",
      "  - `.foot`",
      "",
      "  A `.field` inside a `.bar` drops its margin",
      "- **`pages/x.ts`** — the x page. Classes:",
      "  - `.x-card`",
      "  - `.x-row`",
      "## 6. Keyboard",
    ].join("\n");
    const fixed = ["bar", "bare", "field", "foot", "x-card", "x-row"];
    expect(registeredClasses(inline)).toEqual(fixed);
    expect(registeredClasses(listed)).toEqual(fixed);
    expect(documentedClasses(listed)).toEqual(fixed);
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
    expect(problems).toEqual([".x-row: no stylesheet defines it any more — strike it from §5d, docs/design/sections/5d-page-local-classes.md"]);
  });

  test("every class the stylesheets define is one DESIGN.md §5 names (#2700)", () => {
    const named = new Set(documentedClasses(designText("."), areaFiles(".")));
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

describe("docs/DESIGN.md", () => {
  test("carries no merge conflict markers, in the spine or a section", () => {
    expect(designText(".")).not.toMatch(/^(<<<<<<<|=======$|>>>>>>>)/m);
  });

  test("the spine links every section file once, and each link is a file (#5937)", () => {
    const linked = sectionLinks(readFileSync("docs/DESIGN.md", "utf8"));
    expect(new Set(linked).size).toBe(linked.length);
    expect([...linked].sort()).toEqual(readdirSync("docs/design/sections").filter((n) => n.endsWith(".md")).sort());
  });

  test("reads the sections in the spine's order, so §5 runs from its file to §6's (#5937)", () => {
    const text = designText(".");
    const at = (h: string) => text.search(new RegExp(`^${h}`, "m"));
    expect(at("## 5\\.")).toBeGreaterThan(at("## 4\\."));
    expect(at("### 5d\\.")).toBeGreaterThan(at("## 5\\."));
    expect(at("## 6\\.")).toBeGreaterThan(at("### 5d\\."));
    expect(registeredClasses(text).length).toBeGreaterThan(0);
  });
});

describe("search inputs (#4750)", () => {
  test("no input carries class `search`; the bar sizes type=search once", () => {
    const files = [
      "src/web/pages/browse.ts",
      "src/web/pages/origin-repos.ts",
      "src/web/pages/search.ts",
      "src/web/pages/org.ts",
      "src/web/studio/explore.ts",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/class="[^"]*\bsearch\b[^"]*"/);
      expect(src).toContain('type="search"');
    }
    expect(readFileSync("src/web/style/content.ts", "utf8")).not.toContain(".bar .search");
    expect(readFileSync("src/web/style/components.ts", "utf8")).toContain(".bar .input[type=search]");
  });
});

describe("design check: the quiet-page rules (#8775)", () => {
  const rules = (t: string) => quiet(t).map((f) => f.rule);
  const css = (c: string) => "x = /* css */ `" + c + "`";

  test("label: Status: before a status word, not a sentence", () => {
    expect(rules("h = `<p>Status: Open</p>`")).toEqual(["label"]);
    expect(rules("h = `<dt>State:</dt><dd>${s}</dd>`")).toEqual(["label"]);
    expect(rules("h = `<p>Status: ${s}</p>`")).toEqual(["label"]);
    expect(rules("h = `<p>The status: what a pull is doing now.</p>`")).toEqual([]);
    expect(rules('h = `<span class="dot" title="Open"></span>`')).toEqual([]);
  });

  test("caps: uppercase in a stylesheet, with its line", () => {
    const f = quiet(css(".k{\n text-transform: uppercase}"));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "caps", line: 2 });
    expect(rules(css(".k{font-weight:600}"))).toEqual([]);
    expect(rules("p = `Write it in uppercase`")).toEqual([]);
  });

  test("echo: an icon's aria-label equal to its visible text", () => {
    expect(rules('h = `<button aria-label="Merge"><svg><use href="#m"/></svg> Merge</button>`')).toEqual(["echo"]);
    expect(rules('h = `<button aria-label="Merge"><svg><use href="#m"/></svg></button>`')).toEqual([]);
    expect(rules('h = `<button aria-label="Merge"><svg></svg> Merge pull</button>`')).toEqual([]);
    expect(rules('h = `<button aria-label="Merge">Merge</button>`')).toEqual([]);
  });

  test("accent: a second accent token is a finding; --accent and --accent-fg are not", () => {
    expect(rules("c = /* css */ `a{color:var(--accent);background:var(--accent-fg)}`")).toEqual([]);
    expect(rules("c = /* css */ `a{color:var(--accent-2)} b{--accent-alt:#fff}`")).toEqual(["accent", "accent"]);
  });

  test("inline-colour: a colour name in style, not a token", () => {
    expect(rules('h = `<i style="color: red"></i>`')).toEqual(["inline-colour"]);
    expect(rules('h = `<i style="color: var(--danger)"></i>`')).toEqual([]);
    expect(countFile('h = `<i style="color:#f00"></i>`').colour).toBe(1);
  });

  test("a pull may not add to the debt, and a paid debt must be struck", () => {
    const f = { "src/web/a.ts": quiet(css("a{text-transform:uppercase}")) };
    expect(compareQuiet({ "src/web/a.ts": { caps: 1 } }, f)).toEqual([]);
    expect(compareQuiet({}, f)[0]).toContain("src/web/a.ts:1");
    expect(compareQuiet({ "src/web/a.ts": { caps: 2 } }, f)[0]).toContain("lower it");
  });

  test("the tree breaks no rule beyond its debt", () => {
    const debt = JSON.parse(readFileSync("docs/design/quiet-debt.json", "utf8"));
    expect(compareQuiet(debt, scanQuiet("."))).toEqual([]);
  }, 60_000);
});

describe("design check: a card around one sentence (#11190, principle 7)", () => {
  test("flags a card that wraps one <p> or a bare line, not one holding a list or form", () => {
    expect(loneSentenceCards("x = card(html`<p>Nothing yet.</p>`, { head });")).toHaveLength(1);
    expect(loneSentenceCards("x = card(\n  html`Nothing yet.`,\n  { head });")).toHaveLength(1);
    expect(loneSentenceCards("x = card(html`<p>a</p><ul class=\"list\"></ul>`);")).toEqual([]);
    expect(loneSentenceCards("x = card(html`<form method=\"post\"><p>a</p></form>`);")).toEqual([]);
    expect(loneSentenceCards("x = card(html`<dl><div><dt>a</dt><dd>b</dd></div></dl>`);")).toEqual([]);
    expect(loneSentenceCards("function card(f, d) { return 1; } card(f, d);")).toEqual([]);
  });

  test("a listCard of one bare row is the same box; a row with a link or facts is a row", () => {
    expect(loneSentenceCards("x = listCard([row({ title: `Nothing yet.` })], { head });")).toHaveLength(1);
    expect(loneSentenceCards("x = listCard([row({ title: msg })]);")).toHaveLength(1);
    expect(loneSentenceCards("x = listCard([row({ href: h, title: t })], { head });")).toEqual([]);
    expect(loneSentenceCards("x = listCard([row({ title: t, meta: m, trail: b })]);")).toEqual([]);
    expect(loneSentenceCards("x = listCard([row({ title: a }), row({ title: b })]);")).toEqual([]);
    expect(loneSentenceCards("x = listCard(rows, { head });")).toEqual([]);
  });

  test("a template with a nested backtick is not examined (the scan reads flat text)", () => {
    expect(loneSentenceCards("x = card(html`<p>${a ? `b` : `c`}</p>`, { head });")).toEqual([]);
  });

  test("no page draws one", () => {
    const bad = scanCards(".");
    expect(bad).toEqual([]);
  });
});

describe("the stranger's words (#11458)", () => {
  test("a builder that says a banned word in visible text is named with its line", () => {
    const src = [
      "export const page = () => html`<main>",
      '  <a href="/claim" title="your claim" class="claim-link">Open</a>',
      "  <p>Your child forge is ready.</p>",
      "  <p>${claimUrl} Check your subscription.</p>",
      "</main>`;",
      '// a claim in a comment is not read',
      'export const note = "Autonomy is off here";',
      'const key = `claim:${ip}`;',
    ].join("\n");
    expect(strangerWords(src).map((w) => [w.line, w.word.toLowerCase()])).toEqual([[3, "child"], [4, "subscription"], [7, "autonomy"]]);
  });
  test("only visible text counts: attributes, routes, scripts and styles do not", () => {
    const src = "const a = html`<a href=\"/claim\" aria-label=\"claim\">Open</a><style>.claim { color: red; }</style><script>fetch('/claim')</script>`;\nconst b = \"/claim\";";
    expect(strangerWords(src)).toEqual([]);
  });
  test("the stranger-path builders on main are clean", () => {
    expect(STRANGER_FILES.length).toBe(4);
    expect(scanStranger(process.cwd())).toEqual([]);
  });
});

describe("overlay: nothing closed is drawn (#11831)", () => {
  const css = (body: string) => `export const c = /* css */ \`${body}\`;`;
  test("bare .palette display inside a media query is named", () => {
    const f = overlay(css("@media (max-width: 719px) {\n  .palette { display: flex; }\n}"));
    expect(f.map((x) => x.selector)).toEqual([".palette"]);
    expect(f[0]!.decl).toBe("display: flex");
  });
  test("selectors that require the open state, and display none, pass", () => {
    expect(overlay(css(".palette[open] { display: flex; } .palette:not([open]) { display: none; } dialog:modal { display: grid } .x:not([hidden]) { display: flex }"))).toEqual([]);
    expect(overlay(css(".palette-item[hidden] { display: none; }"))).toEqual([]);
  });
  test("dialog, [popover] and [hidden] with display, visibility or fixed opacity are named", () => {
    const f = overlay(css("dialog { display: block } [popover] { visibility: visible } .row[hidden] { display: flex } .sheet { position: fixed; opacity: 1 }"));
    expect(f.length).toBe(4);
  });
  test("ordinary components are left alone", () => {
    expect(overlay(css(".dialog-foot { display: flex } .card { display: flex }"))).toEqual([]);
  });
  test("an unlisted class is caught once a <dialog> or [popover] carries it", () => {
    const html = '<dialog class="dialog zorp" id="z"></dialog><div popover class="flyout"></div>';
    const extra = overlayClassesIn(html);
    expect(extra.sort()).toEqual(["dialog", "flyout", "zorp"]);
    expect(overlay(css(".zorp { display: flex } .flyout { display: grid }"), extra).length).toBe(2);
    expect(overlay(css(".zorp { display: flex }"))).toEqual([]);
  });
  test("the open state must be on the last compound, not an ancestor", () => {
    expect(overlay(css(".x[open] .toast { display: flex }")).map((x) => x.selector)).toEqual([".x[open] .toast"]);
    expect(overlay(css(".toast:not([hidden]) { display: flex } .x .palette[open] { display: flex }"))).toEqual([]);
  });
  test("an interpolated ${...} is blanked and does not hide the rule after it", () => {
    const f = overlay(css(".a { width: ${1 + 1}px; } .palette { display: flex }"));
    expect(f.map((x) => x.selector)).toEqual([".palette"]);
  });
  test("today's stylesheets pass", () => {
    expect(scanOverlay(process.cwd())).toEqual([]);
  });
});

describe("design check: the layout rules (#12017)", () => {
  const css = (body: string) => "export const s = /* css */ `\n" + body + "\n`;";
  const rules = (body: string, path = "src/web/x.ts") => layoutIn(css(body), path).map((f) => f.rule);

  test("a raw z-index is refused, a token or 0 is not", () => {
    expect(rules(".a { z-index: 40; }")).toEqual(["zindex"]);
    expect(rules(".a { z-index: var(--z-menu); }")).toEqual([]);
    expect(rules(".a { z-index: 0; }")).toEqual([]);
  });
  test("position: fixed is refused outside the overlay host", () => {
    expect(rules(".a { position: fixed; inset: 0; }")).toEqual(["fixed"]);
    expect(rules(".a { position: fixed; }", "src/web/overlay_host.ts")).toEqual([]);
    expect(rules(".a { position: sticky; }")).toEqual([]);
  });
  test("a full-viewport box is refused, a viewport bound is not", () => {
    expect(rules(".a { height: 100dvh; }")).toEqual(["viewport"]);
    expect(rules(".a { width: 100vw; }")).toEqual(["viewport"]);
    expect(rules(".a { max-width: min(560px, calc(100vw - 32px)); }")).toEqual([]);
  });
  test("spacing off the scale is refused, on it is not", () => {
    expect(rules(".a { padding: 5px 8px; }")).toEqual(["space"]);
    expect(rules(".a { margin-top: -10px; }")).toEqual(["space"]);
    expect(rules(".a { gap: 12px; padding: 0 var(--pad, 7px); }")).toEqual([]);
  });
  test("each refusal is one line naming the rule and the fix", () => {
    const files = { "src/web/x.ts": layoutIn(css(".a { z-index: 9; position: fixed; width: 100vw; gap: 5px; }"), "src/web/x.ts") };
    const lines = compareLayout({}, files);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l).toMatch(/^src\/web\/x\.ts:2 {2}(zindex|fixed|viewport|space): .* → /);
    expect(compareLayout(layoutCounts(files), files)).toEqual([]);
  });
  test("the tree is no worse than its named debt", () => {
    const base = JSON.parse(readFileSync("docs/design/baseline.json", "utf8"));
    expect(compareLayout(base.layout ?? {}, scanLayout("."))).toEqual([]);
  }, SLOW);
});
