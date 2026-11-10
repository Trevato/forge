/** Hotkey hints stay out of the layout (#8930): a tooltip and an overlay, never a box in the flow. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { components } from "../src/web/style/components.ts";
import { quiet } from "../scripts/design-lint.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

const get = async (path: string): Promise<string> =>
  (await fetch(`${f.base}${path}`, { headers: { cookie: f.ownerCookie } })).text();

/** The page as a layout sees it: every inline hint box, wherever it is. */
const inlineHints = (page: string): { menu: boolean }[] =>
  [...page.matchAll(/<kbd class="keyhint">/g)].map((m) => ({ menu: page.slice(Math.max(0, m.index! - 400), m.index!).includes("menu-item") }));

test("no page draws a hint in the flow outside a menu, so hints cannot shift it", async () => {
  const repo = f.repos[0]!;
  let hinted = 0;
  for (const path of ["/", "/feed", "/apps", "/asks", `/${repo.ownerName}/${repo.name}`, `/${repo.ownerName}/${repo.name}/issues`, `/${repo.ownerName}/${repo.name}/pulls`]) {
    const page = await get(path);
    expect(inlineHints(page).filter((h) => !h.menu)).toEqual([]);
    hinted += (page.match(/data-hint="/g) ?? []).length;
    // A hint is only an attribute: removing it leaves no text, element or class behind.
    const bare = page.replace(/ data-hint="[^"]*"/g, "");
    expect(page.length - bare.length).toBe((page.match(/ data-hint="[^"]*"/g) ?? []).join("").length);
    expect(bare).not.toContain("data-hint");
  }
  expect(hinted).toBeGreaterThan(5);
});

test("the top bar's wordmark and tabs carry hints as attributes, not as content", async () => {
  const page = await get("/");
  expect(page).toMatch(/class="wordmark" data-shortcut="g h" data-hint="g h"\s*><span class="mark"><\/span>forge<\/a/);
});

/** Every declaration of every rule that selects `[data-hint]`, by selector (comments dropped). */
const hintRules = (): { sel: string; decls: Map<string, string> }[] =>
  [...components.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*\[data-hint\][^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1]!.trim(),
    decls: new Map(m[2]!.split(";").map((d) => d.split(/:(.*)/s).map((x) => x?.trim() ?? "")).filter((d) => d[0]).map((d) => [d[0]!, d[1]!] as [string, string])),
  }));
const ruleFor = (sel: string) => hintRules().find((r) => r.sel === sel)?.decls ?? new Map<string, string>();

// A source check, not a measured layout: there is no layout engine in the test run,
// so this reads every rule that can touch a hinted element and proves none can size it.
test("layout is the same with and without hints: no rule gives a hinted element or its flow any box", () => {
  const rules = hintRules();
  expect(rules.length).toBeGreaterThan(5);
  const boxy = /^(display|width|height|min-|max-|margin|padding|border|flex|grid|float|overflow|top|left|right|bottom|inset|line-height|font)/;
  for (const { sel, decls } of rules) {
    expect(sel).not.toContain("::after");
    if (/::before/.test(sel)) {
      // The chip is out of flow wherever a rule moves it, or it is not drawn at all.
      if (decls.has("display")) expect(decls.get("display")).toBe("none");
      if (decls.has("position")) expect(decls.get("position")).toBe("absolute");
      expect(decls.has("float")).toBe(false);
    } else {
      for (const name of decls.keys()) expect([sel, name, name.match(boxy) !== null]).toEqual([sel, name, false]);
    }
  }
  const chip = ruleFor("[data-hint]::before");
  expect(chip.get("position")).toBe("absolute");
  expect(chip.get("opacity")).toBe("0");
  expect(chip.get("pointer-events")).toBe("none");
  expect(components).toMatch(/@media \(pointer: coarse\) \{ \[data-hint\]::before \{ display: none; \} \}/);
});

test("the host rule has no specificity, so a component that positions itself keeps its position", () => {
  expect(ruleFor(":where([data-hint])").get("position")).toBe("relative");
  expect(hintRules().filter((r) => /^\[data-hint\]\s*$/.test(r.sel))).toEqual([]);
});

test("the chip is ::before: a current tab's ::after line and a menu's caret stay theirs", () => {
  expect(components).toContain('.tabs > a[aria-current="page"]::after');
  expect(hintRules().some((r) => r.sel.includes("::after"))).toBe(false);
});

test("in a card the chip sits on the corner above the label; in the tab strip it sits in the top padding", () => {
  const card = ruleFor(".card [data-hint]::before");
  expect([card.get("top"), card.get("right"), card.get("left"), card.get("transform")]).toEqual(["0", "0", "auto", "translateY(-60%)"]);
  const tab = ruleFor(".tabs [data-hint]::before");
  expect([tab.get("top"), tab.get("line-height")]).toEqual(["0", "12px"]);
});

test("at the window's edges the chip hangs inward, so a 360px window never scrolls sideways", () => {
  expect([...ruleFor(".wordmark[data-hint]::before").entries()]).toEqual([["left", "0"], ["transform", "none"]]);
  expect([...ruleFor(".topbar-tools [data-hint]::before").entries()]).toEqual([["left", "auto"], ["right", "0"], ["transform", "none"]]);
});

test("the chip's text is not part of the element's name; a single key is announced as aria-keyshortcuts", async () => {
  expect(ruleFor("[data-hint]::before").get("content")).toBe('attr(data-hint) / ""');
  const feed = readFileSync("src/web/studio/feed.ts", "utf8");
  expect(feed).toContain("hintAttr(DISMISS_KEY)");
  const { hintAttr } = await import("../src/web/ui.ts");
  expect(String(hintAttr("x"))).toBe('data-hint="x" aria-keyshortcuts="x"');
  expect(String(hintAttr("g h"))).toBe('data-hint="g h"');
});

test("signed in, the top bar's Talk icon and Asks carry their hints", async () => {
  const page = await get("/");
  expect(page).toMatch(/aria-label="Talk to the forge" data-shortcut="g t" data-hint="Talk to the forge · g t"/);
  expect(page).toMatch(/href="\/asks" data-shortcut="g q" data-hint="g q"/);
});

test("hover and focus show a hint with no script: the rule is CSS alone", () => {
  expect(components).toMatch(/\[data-hint\]:focus-within::before/);
  expect(components).toMatch(/\[data-hint\]:hover::before/);
});

test("an element does not carry the key twice: no title beside its data-hint", async () => {
  for (const path of ["/", "/feed"]) {
    const page = await get(path);
    for (const tag of page.match(/<(?:a|button)\b[^>]*data-hint="[^"]*"[^>]*>/g) ?? []) expect(tag).not.toMatch(/\btitle="/);
  }
});

test("? opens the help at once, Alt lays the hints; Escape clears them", () => {
  const client = readFileSync("src/web/client.ts", "utf8");
  expect(client).toContain("hints(false); openHelp();");
  expect(client).toContain("escClosedHints = doc.documentElement.hasAttribute('data-hints');");
});

test("holding Option reveals hints; releasing or leaving hides them", () => {
  const client = readFileSync("src/web/client.ts", "utf8");
  expect(client).toContain("e.key === 'Alt') hints(true)");
  expect(client).toContain("e.key === 'Alt') hints(false)");
  expect(client).toContain("window.addEventListener('blur'");
});

test("the check refuses an inline hint outside a menu item and allows one inside", () => {
  expect(quiet("html`<a>Go${keyHint(\"g h\")}</a>`").map((x) => x.rule)).toEqual(["keyhint"]);
  expect(quiet('html`<kbd class="keyhint">x</kbd>`').map((x) => x.rule)).toEqual(["keyhint"]);
  expect(quiet('html`<a class="menu-item">Go${keyHint("g h")}</a>`')).toEqual([]);
});

test("keyhint is anchored to the open menu row, not to the nearby text", () => {
  // False positive: a menu row that closed, then a button with a hint.
  expect(quiet('html`<a class="menu-item">Go</a><button class="btn">Save${keyHint("s")}</button>`').map((x) => x.rule)).toEqual(["keyhint"]);
  // False negative: a long row, with more than 400 characters before the hint.
  const long = `html\`<a class="menu-item" href="/x"><span class="grow">${"word ".repeat(120)}</span>\${keyHint("g h")}</a>\``;
  expect(quiet(long)).toEqual([]);
  // Palette rows too, and a nested element does not close the row early.
  expect(quiet('html`<div class="palette-item"><span>a</span>${keyHint("g h")}</div>`')).toEqual([]);
  expect(quiet('html`<div class="palette-item"><div>a</div>${keyHint("g h")}</div>`')).toEqual([]);
});

test("no element carries an empty data-hint, which would draw an empty chip", () => {
  const { Glob } = Bun;
  for (const file of new Glob("src/web/**/*.ts").scanSync()) expect([file, /data-hint>|data-hint\s|\[data-hint\]"/.test(readFileSync(file, "utf8").replace(/data-hint\s*=/g, ""))]).toEqual([file, false]);
});
