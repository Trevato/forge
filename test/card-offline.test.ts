/**
 * A card page is a host's sandboxed frame with a strict content security
 * policy (MCP Apps: no network unless `_meta.ui.csp` names it; Claude and
 * ChatGPT both apply it), so it must be complete in itself: its styles are in
 * the document, in both colour schemes, it names no network address, and its
 * heading and a line of words show with scripts off. Every kind is held to it.
 */
import { describe, expect, test } from "bun:test";
import {
  CARD_KINDS,
  CARD_RESOURCE_META,
  CARD_SHELL,
} from "../src/web/studio/cards.ts";

/** The most a card page may weigh: it is sent on every `resources/read`. */
const CEILING_BYTES = 12_000;

describe("every card page is self-contained", () => {
  for (const kind of CARD_KINDS) {
    test(kind, () => {
      const page = CARD_SHELL(kind);
      expect(Buffer.byteLength(page)).toBeLessThan(CEILING_BYTES);
      // No stylesheet, font, image or script is fetched, and no tag points at an address.
      expect(page).not.toMatch(/<link\b/i);
      expect(page).not.toMatch(
        /\b(?:src|href|action|poster|srcset)\s*=\s*["']?(?:https?:)?\/\//i,
      );
      expect(page).not.toMatch(
        /<(?:img|iframe|object|embed|video|audio|source)\b/i,
      );
      expect(page).not.toMatch(
        /\bfetch\(|new (?:XMLHttpRequest|WebSocket|EventSource)|sendBeacon\(/,
      );
      // The styles are inline, light and dark, and the host's theme can override either.
      const css = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
      expect(css).not.toMatch(/@import|url\(/i);
      expect(css).toContain("prefers-color-scheme:dark");
      expect(css).toContain(":root[data-theme=dark]");
      expect(css).toContain(":root[data-theme=light]");
      expect(css).toMatch(/body\{[^}]*background:var\(--c-bg\)/);
      expect(page).toContain('<meta name="color-scheme" content="light dark">');
      // With scripts off the page still says what it is and why it is waiting.
      const body = page.slice(
        page.indexOf('<div id="card">'),
        page.indexOf("<script>"),
      );
      expect(body).toMatch(/<h2>[^<]+<\/h2><p class="status">[^<]+<\/p>/);
      // The page is complete before any host speaks: it draws on load from the globals ChatGPT sets, then asks the host.
      expect(page.indexOf("fromOpenAI();")).toBeGreaterThan(-1);
      expect(page.indexOf("fromOpenAI();")).toBeLessThan(
        page.indexOf('method: "ui/initialize"'),
      );
    });
  }

  test("the resource declares no network and no added border", () => {
    expect(CARD_RESOURCE_META.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
    });
    expect(CARD_RESOURCE_META.ui.prefersBorder).toBe(false);
  });
});
