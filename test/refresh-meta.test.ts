/**
 * A page that changes on its own carries a `meta refresh` for browsers with
 * no script. A browser running the page's script must never schedule it: a
 * refresh is set the moment the parser meets the tag, and removing the tag
 * afterwards does not cancel it — which is how a live run page threw away
 * the reader's scroll every five seconds. So the reload is written inside
 * `<noscript>`, and only a redirect (`url`) stands on its own.
 */
import { describe, expect, test } from "bun:test";
import { refreshMeta } from "../src/web/layout.ts";

describe("the refresh meta", () => {
  test("a reload is for browsers without a script only", () => {
    const tag = String(refreshMeta({ seconds: 5 })).replace(/\s+/g, " ");
    expect(tag).toMatch(
      /^<noscript ?><meta http-equiv="refresh" content="5" ?\/><\/noscript>$/,
    );
  });

  test("a redirect stays in force with or without a script", () => {
    const tag = String(refreshMeta({ seconds: 1, url: "/trevato/forge" }));
    expect(tag).toContain('content="1; url=/trevato/forge"');
    expect(tag).not.toContain("noscript");
  });

  test("the page's script no longer reaches for the tag it cannot cancel", async () => {
    const client = await Bun.file(
      new URL("../src/web/client.ts", import.meta.url),
    ).text();
    expect(client).not.toContain('meta[http-equiv="refresh"]');
  });
});
