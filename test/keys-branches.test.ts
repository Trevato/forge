/** The branches page joins the shell's j/k traversal: one data-nav row per branch, Enter opening its tree, Esc coming back, no key firing in a field. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { quietLogs } from "./helpers/globals.ts";
import { listedForge, type ListedForge } from "./helpers/listed-forge.ts";
import { expectListKeys, mainOf, navHrefs, shellPage } from "./helpers/shell-page.ts";

quietLogs();
let forge: ListedForge;
beforeAll(async () => void (forge = await listedForge()));
afterAll(() => forge.close());

const served = async () => mainOf(await forge.get("/alice/notes/branches"));

test("the served page draws one focusable row per branch; j/k focus it, Enter opens its tree, Esc comes back, fields keep their keys", async () => {
  const html = await served();
  const hrefs = await navHrefs(html);
  expect([...hrefs].sort()).toEqual(["/alice/notes/tree/feature%2Fx", "/alice/notes/tree/main"]);
  await expectListKeys({ path: "/alice/notes/branches", html, hrefs, opened: { path: hrefs[0]!, body: "<main>tree</main>" } });
});

test("the focus marker is the row itself, and `?` lists the keys", async () => {
  const p = await shellPage("/alice/notes/branches", await served());
  p.key("j");
  expect(p.doc.activeElement.getAttribute("tabindex")).toBe("-1");
  expect(p.doc.activeElement.hasAttribute("data-nav")).toBe(true);
  expect(p.key("?").defaultPrevented).toBe(true);
});
