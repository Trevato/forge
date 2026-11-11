/** The page's `?` is closed until asked for, open and focused on `?help`, and says its word (#11170). */
import { expect, test } from "bun:test";
import { helpAsked, pageHelp } from "../src/web/page_help.ts";
import { lookSlot } from "../src/core/looks.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { MERGE_QUEUE_HELP } from "../src/flow/help.ts";

const notes = [["Name", "What it means"]] as const;

test("closed by default, with a visible Help word", () => {
  const h = String(pageHelp(notes));
  expect(h).not.toMatch(/ open/);
  expect(h).not.toContain("autofocus");
  expect(h).toContain("Help</summary>");
});

test("open, summary focused, when asked", () => {
  const h = String(pageHelp(notes, true));
  expect(h).toContain("data-page-help open>");
  expect(h).toContain("<summary autofocus>");
});

test("?help is asked by the query alone", () => {
  expect(helpAsked("http://x/boards?help")).toBe(true);
  expect(helpAsked(new URL("http://x/boards?a=1&help="))).toBe(true);
  expect(helpAsked("http://x/boards")).toBe(false);
});

test("a look with a query has its own slot, never the plain page's", () => {
  expect(lookSlot("/boards?help", "phone")).toBe("boards-help-phone");
  expect(lookSlot("/boards?help", "phone")).not.toBe(lookSlot("/boards", "phone"));
});

test("the terminal's Flow screen carries the same explanations as the web's ?", () => {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-help-")), port: 0 });
  const text = flowLines(app.db, new Date(), [], undefined, []).join(" ").replace(/\s+/g, " ");
  expect(text).toContain("/boards?help");
  expect(text).toContain("Checks queued to start");
  expect(text).toContain(MERGE_QUEUE_HELP.slice(0, 40));
  app.close();
});
