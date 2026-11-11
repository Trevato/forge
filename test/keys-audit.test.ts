/** The audit's contract-change rows join the shell's j/k traversal (#10736): one focusable row each, Enter opening its commit; none when empty. */
import { expect, test } from "bun:test";
import type { ContractChange } from "../src/contract/changes.ts";
import type { Repo } from "../src/core/repos.ts";
import { contractChangesSection } from "../src/web/pages/audit.ts";
import { expectListKeys, navHrefs, shellPage } from "./helpers/shell-page.ts";

const change = (n: number): ContractChange => ({
  repo: { ownerName: "alice", name: "notes" } as Repo,
  oid: String(n).repeat(40), date: "2026-03-05T10:00:00Z", author: "a", subject: `Change ${n}`,
  loosened: [], tightened: [], unsound: false, removed: false,
});
const commit = (n: number) => `/alice/notes/commit/${String(n).repeat(40)}`;

test("each contract change is a focusable row; j/k focus it, Enter opens its commit, Esc comes back, fields keep their keys", async () => {
  const markup = String(contractChangesSection([change(1), change(2)]));
  const hrefs = await navHrefs(markup);
  expect(hrefs).toEqual([commit(1), commit(2)]);
  await expectListKeys({ path: "/audit", html: markup, hrefs, opened: { path: commit(1), body: "<main>commit</main>" } });
});

test("a focused row is the row itself, reachable by script only (tabindex -1)", async () => {
  const p = await shellPage("/audit", String(contractChangesSection([change(1)])));
  p.key("j");
  expect(p.doc.activeElement.getAttribute("tabindex")).toBe("-1");
  expect(p.doc.activeElement.hasAttribute("data-nav")).toBe(true);
});

test("no changes, no data-nav row", () => {
  expect(String(contractChangesSection([]))).not.toContain("data-nav");
});
