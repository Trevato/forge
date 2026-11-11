import { expect, test } from "bun:test";
import { contextNote, parseContext } from "../src/actions/tell_context.ts";

test("a page told with a #fragment is told without it", () => {
  const c = parseContext({ page: "https://app.example.test/a?b=1#access_token=secret" });
  expect(c).toEqual({ page: "https://app.example.test/a?b=1" });
  expect(contextNote(c ?? undefined)).not.toContain("secret");
});

test("a page without a fragment is kept as it was", () => {
  expect(parseContext({ page: "https://app.example.test/a" })).toEqual({
    page: "https://app.example.test/a",
  });
});

test("only a door that asked for a preview's pull says 'from preview'", () => {
  const where = parseContext({ page: "https://n.apps.test/a?x=1", pull: 7 }) ?? undefined;
  const plain = contextNote(where);
  expect(plain).not.toContain("from preview");
  expect(plain).toContain("- page: https://n.apps.test/a?x=1");
  expect(plain).toContain("- pull: #7");
  const said = contextNote(where, { preview: true });
  expect(said).toContain("- from preview of #7, page /a");
  expect(said).not.toContain("- page:");
  expect(said).not.toContain("- pull:");
  // A preview with no pull is no preview.
  expect(contextNote(parseContext({ page: "https://n.apps.test/a" }) ?? undefined, { preview: true })).toContain("- page:");
});
