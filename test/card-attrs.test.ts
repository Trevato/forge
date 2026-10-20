import { describe, expect, test } from "bun:test";
import { html } from "../src/web/html.ts";
import { card } from "../src/web/ui.ts";
import { feedCard } from "../src/web/studio/feed.ts";

const root = (s: string) => /^<div\b[^>]*>/.exec(s.trim())?.[0] ?? "";

describe("card() attrs", () => {
  test("attrs land on the .card element itself", () => {
    const out = card(html`<p>x</p>`, { attrs: html`data-item="e1" tabindex="0"` }).text;
    const tag = root(out);
    expect(tag).toContain('class="card"');
    expect(tag).toContain('data-item="e1"');
    expect(tag).toContain('tabindex="0"');
  });

  test("without attrs the output is the plain card", () => {
    const plain = card(html`<p>x</p>`).text;
    expect(card(html`<p>x</p>`, {}).text).toBe(plain);
    expect(root(plain).replace(/\s+/g, " ")).toBe('<div class="card" >');
    expect(plain).not.toContain("data-");
    expect(plain).not.toContain("tabindex");
  });

  test("a feed card carries its hooks on the same .card element", () => {
    const out = feedCard({
      id: "event:e1",
      kind: "run",
      app: "a/b",
      actor: null,
      at: new Date().toISOString(),
      link: "/a/b/runs/r",
      what: "w",
      reason: "r",
      score: 1,
    }).text;
    const tag = root(out);
    expect(tag).toContain('class="card"');
    for (const a of ['data-item="event:e1"', "data-nav", 'tabindex="0"']) expect(tag).toContain(a);
  });
});
