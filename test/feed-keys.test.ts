/**
 * The feed moves by keyboard: j/k step between posts, Enter opens the one in
 * focus, ? lists the keys. The decision (key_decision.ts) is tested on plain
 * data; the rows it hands a key to are the shell's real table.
 */
import { expect, test } from "bun:test";
import { shellJs } from "../src/web/client.ts";
import { decideKey, keyDecisionJs, type KeyFacts } from "../src/web/key_decision.ts";

const plain: KeyFacts = { key: "j", ctrl: false, meta: false, alt: false, inField: false, inDialog: false, hasChord: false };
const decide = (o: Partial<KeyFacts>) => decideKey({ ...plain, ...o });

test("a plain key is the table's to answer", () => {
  for (const key of ["j", "k", "Enter", "?", "Escape", "o"]) expect(decide({ key })).toBe("key");
});

test("in a field, a select or a contenteditable nothing runs, and Escape leaves it", () => {
  // inField is what input, textarea, select and [contenteditable] all become at the boundary.
  for (const key of ["j", "k", "Enter", "?", "o"]) expect(decide({ key, inField: true })).toBeNull();
  expect(decide({ key: "Escape", inField: true })).toBe("blur");
});

test("Ctrl, Meta or Alt held leaves the browser's shortcut alone", () => {
  for (const mod of ["ctrl", "meta", "alt"] as const) expect(decide({ [mod]: true })).toBeNull();
});

test("a chord with a row answers, from a field too; one without is the browser's", () => {
  expect(decide({ key: "k", ctrl: true, hasChord: true })).toBe("chord");
  expect(decide({ key: "Enter", meta: true, hasChord: true, inField: true })).toBe("chord");
  expect(decide({ key: "k", ctrl: true, inField: true })).toBeNull();
});

test("an open dialog owns every key", () => {
  expect(decide({ inDialog: true })).toBeNull();
  expect(decide({ key: "Enter", ctrl: true, hasChord: true, inDialog: true })).toBeNull();
});

test("the shell ships the decision and its handler obeys it, ahead of any key lookup", () => {
  expect(shellJs).toContain(keyDecisionJs);
  const at = shellJs.indexOf("var what = decideKey(");
  expect(at).toBeGreaterThan(0);
  expect(shellJs.indexOf("if (what !== 'key') return;")).toBeGreaterThan(at);
  expect(shellJs.indexOf("var row = rowForKey(e.key);")).toBeGreaterThan(shellJs.indexOf("if (what !== 'key') return;"));
});

test("the feed's keys are the shell's real rows", () => {
  const from = shellJs.indexOf("var STATIC_KEYS = [");
  const to = shellJs.indexOf("// Built with DOM nodes");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const noop = () => {};
  const rows = new Function(
    "doc", "pageBox", "focusBox", "openPalette", "move", "openFocused", "openGoto", "hints", "openHelp", "leaveToList", "openNewIssue", "escClosedHints",
    `function submitBox(){}\n${shellJs.slice(from, to)}\nreturn STATIC_KEYS;`,
  )({ querySelector: () => null }, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, false) as [string, string, string[]][];
  const label = (k: string) => rows.find((r) => r[2].includes(k))?.[0];
  expect(label("j")).toBe("j / k");
  expect(label("k")).toBe("j / k");
  expect(label("Enter")).toBe("o or Enter");
  expect(label("?")).toBe("?");
  expect(label("Escape")).toBe("Esc");
});

test("a feed post is a focusable row, and its link is what Enter opens", async () => {
  const { feedCard } = await import("../src/web/studio/feed.ts");
  const html = String(
    feedCard({ id: "i1", app: "a/b", kind: "run", what: "Shipped", reason: "", link: "/a/b/runs/r1", at: Date.now(), actor: "a" } as never),
  );
  expect(html).toMatch(/data-nav\s+tabindex="0"/);
  expect(html).toContain('<a href="/a/b/runs/r1" data-feed-open>');
});

test("the key decision stays under the 1.5 KB the feature may add", () => {
  expect(Buffer.byteLength(keyDecisionJs)).toBeLessThan(1500);
  const handler = shellJs.slice(shellJs.indexOf("var what = decideKey("), shellJs.indexOf("if (what !== 'key') return;"));
  expect(Buffer.byteLength(keyDecisionJs) + Buffer.byteLength(handler)).toBeLessThan(1500);
});
