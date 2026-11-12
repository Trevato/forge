import { expect, test } from "bun:test";
import { forgeCard } from "../src/web/studio/asks_page.ts";

// Principle 7 took the card away; the line must still read as an alert.
test("a degraded forge on /asks is an alert line in the danger tone, with Health on its own row", () => {
  const out = String(forgeCard({ cause: "errors", sentence: "Errors <now>.", since: "2020-01-01T00:00:00.000Z", href: "/x" }));
  const line = /<p role="alert">([\s\S]*?)<\/p>/.exec(out);
  expect(line).not.toBeNull();
  expect(line![1]).toContain('class="dot" data-tone="danger"');
  expect(line![1]).toContain('href="/x"');
  expect(line![1]).not.toContain("/api/v1/health");
  expect(out).toContain('<div class="bar">');
  expect(out).toContain("/api/v1/health");
  expect(out).not.toContain("<now>");
  expect(out).not.toContain('class="card');
});
