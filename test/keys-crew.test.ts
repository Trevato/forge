/** The crew page's spending rows join the shell's j/k traversal: one data-nav row per autonomous app, Enter opening its autonomy settings,
 * Esc coming back, no key firing in a field. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { quietLogs } from "./helpers/globals.ts";
import { listedForge, type ListedForge } from "./helpers/listed-forge.ts";
import { expectListKeys, mainOf, navHrefs, shellPage } from "./helpers/shell-page.ts";

quietLogs();
let forge: ListedForge;
beforeAll(async () => void (forge = await listedForge()));
afterAll(() => forge.close());

/** The spending list out of the served page: the settings menu around it has rows of its own. */
async function served(): Promise<string> {
  const { Window } = await import("happy-dom");
  const doc = new Window({ url: "http://forge.test/" }).document as any;
  doc.body.innerHTML = mainOf(await forge.get("/settings/crew"));
  return doc.querySelector('a[href$="/settings/autonomy"]').closest("ul").outerHTML;
}

test("the served page draws one focusable spending row per autonomous app; j/k focus it, Enter opens its autonomy page, Esc comes back, fields keep their keys", async () => {
  const html = await served();
  const hrefs = await navHrefs(html);
  expect(hrefs).toEqual(["/alice/notes/settings/autonomy"]);
  await expectListKeys({ path: "/settings/crew", html, hrefs, opened: { path: hrefs[0]!, body: "<main>autonomy</main>" } });
});

test("the focus marker is the row itself, and `?` lists the keys", async () => {
  const p = await shellPage("/settings/crew", await served());
  p.key("j");
  expect(p.doc.activeElement.getAttribute("tabindex")).toBe("-1");
  expect(p.key("?").defaultPrevented).toBe(true);
});
