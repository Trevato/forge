/** The resolve page's other-file links join the shell's j/k traversal (#10736): one data-nav per other file, none for one file. */
import { expect, test } from "bun:test";
import { fileSwitcher } from "../src/web/pages/conflicts.ts";
import { expectListKeys, navHrefs, shellPage } from "./helpers/shell-page.ts";

const here = "/a/b/pulls/1/resolve";

test("every file but the current one is a data-nav link; j/k focus it and Enter opens it", async () => {
  const markup = String(fileSwitcher(here, ["x.txt", "y z.txt", "w.txt"], "x.txt"));
  const hrefs = await navHrefs(markup);
  expect(hrefs).toEqual([`${here}?file=y%20z.txt`, `${here}?file=w.txt`]);
  expect(markup).toContain("<strong");
  await expectListKeys({ path: here, html: markup, hrefs, opened: null });
});

test("a single conflicted file draws no data-nav", () => {
  expect(String(fileSwitcher(here, ["x.txt"], "x.txt"))).not.toContain("data-nav");
});

test("Esc on the resolve page, which now has data-nav, neither leaves nor throws; a pull page without rows still does", async () => {
  const stale = JSON.stringify({ list: "/a/b/pulls", to: "/a/b/pulls/1", href: "/a/b/pulls/1" });
  const resolve = await shellPage(here, String(fileSwitcher(here, ["x", "y"], "x")), { "nav-from": stale });
  resolve.key("Escape");
  expect(resolve.assigned).toEqual([]); // it was never the opened page, so there is nowhere to leave to
  const pull = await shellPage("/a/b/pulls/1", "<main>pull</main>", { "nav-from": stale });
  pull.key("Escape");
  expect(pull.assigned).toEqual(["/a/b/pulls"]);
});
