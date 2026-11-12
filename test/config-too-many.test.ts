/** A config file with too many values for a form says so in one plain muted line, no card (#10054). */
import { expect, test } from "bun:test";
import { config } from "../src/web/render/config.ts";
import { MAX_FIELDS } from "../src/web/render/config-form.ts";

test("a JSON file over MAX_FIELDS is one plain muted line, not a card", () => {
  const big = JSON.stringify(Object.fromEntries(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => [`k${i}`, i])));
  const body = new TextEncoder().encode(big);
  const out = String(config({ path: "big.json", size: body.length, body, media: "/o/r/media/main/big.json", download: "/o/r/raw/main/big.json" }).content);
  expect(out).toContain("too many for a form. Source shows it whole.");
  expect(out).toContain('<p class="muted">');
  expect(out).not.toContain("card");
});
