/** The proposals to the parent forge join the shell's j/k traversal: one data-nav row each, Enter opening the parent's pull, no key firing in a field. */
import { expect, test } from "bun:test";
import type { ForgeProposal } from "../src/actions/upstream.ts";
import { proposalSection } from "../src/web/pages/chain.ts";
import { expectListKeys, navHrefs, shellPage } from "./helpers/shell-page.ts";

const proposal = (n: number): ForgeProposal => ({
  number: n, title: `Proposal ${n}`, branch: `b${n}`, state: "open", reachable: true, url: `https://parent.test/a/b/pulls/${n}`,
});
const markup = () => String(proposalSection("/alice/notes", [proposal(1), proposal(2)], false));

test("each proposal is a focusable row; j/k focus it, Enter opens it, fields keep their keys", async () => {
  const hrefs = await navHrefs(markup());
  expect(hrefs).toEqual(["https://parent.test/a/b/pulls/1", "https://parent.test/a/b/pulls/2"]);
  // The links leave for the parent forge, so there is no page of ours to press Esc on.
  await expectListKeys({ path: "/alice/notes/following", html: markup(), hrefs, opened: null });
});

test("the focus marker is the row itself, and `?` lists the keys", async () => {
  const p = await shellPage("/alice/notes/following", markup());
  p.key("j");
  expect(p.doc.activeElement.getAttribute("tabindex")).toBe("-1");
  expect(p.key("?").defaultPrevented).toBe(true);
});

test("no proposals, no data-nav row", () => {
  expect(String(proposalSection("/alice/notes", [], false))).not.toContain("data-nav");
});
