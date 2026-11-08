/** The Secrets card is one card in three places, drawn as the home page draws a block (#9718). */
import { expect, test } from "bun:test";
import type { SecretName, SecretScope } from "../src/core/secret_store.ts";
import { secretsCard } from "../src/web/pages/secrets.ts";

const names: SecretName[] = [
  { name: "CLOUDFLARE_API_TOKEN", scope: "forge", scopeId: "", updatedAt: "2026-11-01T10:00:00.000Z", lastReadAt: null },
  { name: "BUCKET_KEY", scope: "forge", scopeId: "", updatedAt: "2026-11-02T10:00:00.000Z", lastReadAt: "2026-11-03T10:00:00.000Z" },
];

const places: [SecretScope, string][] = [
  ["forge", ""],
  ["org", "acme"],
  ["repo", "acme/site"],
];

function classes(markup: string): string[] {
  const found = new Set<string>();
  for (const m of markup.matchAll(/class="([^"]*)"/g)) for (const c of m[1]!.split(/\s+/)) if (c) found.add(c);
  return [...found].sort();
}

test("the card has the same classes at the forge, an organization and a repository", () => {
  const drawn = places.map(([scope, ref]) => classes(String(secretsCard(scope, ref, names))));
  expect(drawn[1]).toEqual(drawn[0]!);
  expect(drawn[2]).toEqual(drawn[0]!);
});

test("the card is a heading over rows, not a boxed card with icons", () => {
  for (const [scope, ref] of places) {
    const markup = String(secretsCard(scope, ref, names));
    expect(markup).toContain('<section class="settings-block">');
    expect(markup).toContain("<h2>Secrets</h2>");
    expect(markup).toContain('class="list setting-list"');
    const found = classes(markup);
    expect(found).not.toContain("card");
    expect(found).not.toContain("card-head");
    expect(found).not.toContain("row-lead");
  }
});

test("each row keeps its name, when it was set and when it was last opened; the value field stays empty", () => {
  const markup = String(secretsCard("repo", "acme/site", names));
  expect(markup).toContain("CLOUDFLARE_API_TOKEN");
  expect(markup).toContain("never used");
  expect(markup).toContain("last used");
  expect(markup.match(/set <time/g)?.length).toBe(2);
  const value = /<input[^>]*name="value"[^>]*>/.exec(markup)?.[0] ?? "";
  expect(value).toContain('type="password"');
  expect(value).not.toContain("value=");
  expect(markup).toContain('action="/settings/secrets"');
  expect(markup).toContain('action="/settings/secrets/delete"');
});

test("the card says what it is for in one sentence, the same in every place", () => {
  const intros = places.map(([scope, ref]) => {
    const markup = String(secretsCard(scope, ref, names));
    const intro = /<h2>Secrets<\/h2>\s*<p class="muted small">([^<]*)<\/p>/.exec(markup)?.[1]?.trim() ?? "";
    expect(intro.length).toBeGreaterThan(0);
    expect(intro.match(/[.!?](\s|$)/g)?.length).toBe(1);
    return intro;
  });
  expect(new Set(intros).size).toBe(1);
});
