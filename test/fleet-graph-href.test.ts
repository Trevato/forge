/**
 * The way to the fleet graph from the board, the spend page and an app's
 * page (#578): one `repo=` per name, URL-encoded, so whatever a page holds
 * arrives as the graph's selection and nothing in it can break the query
 * or the attribute it is printed in.
 */
import { expect, test } from "bun:test";
import { fleetSelection } from "../src/actions/fleet-graph.ts";
import { FLEET_GRAPH_MAX_REPOS } from "../src/actions/fleet-graph.ts";
import { fleetGraphHref, narrowedGraphHref } from "../src/web/fleet-graph.ts";
import { html } from "../src/web/html.ts";

test("no names is the graph's own default", () => {
  expect(fleetGraphHref([])).toBe("/fleet/graph");
});

test("each name is one encoded repo=, once, and the graph reads them back", () => {
  const href = fleetGraphHref(["alice/mill", "bob/ledger-app", "alice/mill"]);
  expect(href).toBe("/fleet/graph?repo=alice%2Fmill&repo=bob%2Fledger-app");
  const back = new URL(href, "http://x").searchParams.getAll("repo");
  expect(fleetSelection(back)).toEqual({ ok: true, value: ["alice/mill", "bob/ledger-app"] });
});

test("a hostile name cannot add a parameter or leave the attribute", () => {
  const href = fleetGraphHref([`a/b&repo=evil"><script>`]);
  expect(new URL(href, "http://x").searchParams.getAll("repo")).toEqual([
    `a/b&repo=evil"><script>`,
  ]);
  const out = String(html`<a href="${href}">graph</a>`);
  expect(out).not.toContain("<script>");
  expect(out).not.toContain('"><');
});

test("a board not narrowed links the viewer's whole graph", () => {
  expect(narrowedGraphHref(false, [])).toBe("/fleet/graph");
  expect(narrowedGraphHref(false, ["alice/mill"])).toBe("/fleet/graph");
});

test("a narrowed board links exactly its apps, and nothing rather than wider or cut", () => {
  expect(narrowedGraphHref(true, ["alice/mill"])).toBe("/fleet/graph?repo=alice%2Fmill");
  // `?apps=` that names nothing the viewer owns: no link, not the whole fleet.
  expect(narrowedGraphHref(true, [])).toBeNull();
  const many = Array.from({ length: FLEET_GRAPH_MAX_REPOS + 1 }, (_, i) => `a/r${i}`);
  expect(narrowedGraphHref(true, many)).toBeNull();
});
