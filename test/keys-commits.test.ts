/** The commit log joins the shell's j/k traversal: one data-nav link row per commit, Enter opening it, Esc coming back, no key firing in a field. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { quietLogs } from "./helpers/globals.ts";
import { listedForge, type ListedForge } from "./helpers/listed-forge.ts";
import { expectListKeys, mainOf, navHrefs, shellPage } from "./helpers/shell-page.ts";

quietLogs();
let forge: ListedForge;
beforeAll(async () => void (forge = await listedForge()));
afterAll(() => forge.close());

const served = async () => mainOf(await forge.get("/alice/notes/commits?ref=main"));

test("the served log draws one focusable row per commit; j/k focus it, Enter opens it, Esc comes back, fields keep their keys", async () => {
  const html = await served();
  const hrefs = await navHrefs(html);
  expect(hrefs.length).toBe(2);
  for (const h of hrefs) expect(h).toMatch(/^\/alice\/notes\/commit\/[0-9a-f]{40}$/);
  await expectListKeys({ path: "/alice/notes/commits", html, hrefs, opened: { path: hrefs[0]!, body: "<main>commit</main>" } });
});

test("the focus marker is the row itself, and `?` lists the keys", async () => {
  const p = await shellPage("/alice/notes/commits?ref=main", await served());
  p.key("j");
  expect(p.doc.activeElement.getAttribute("tabindex")).toBe("-1");
  expect(p.key("?").defaultPrevented).toBe(true);
});
