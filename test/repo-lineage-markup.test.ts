import { expect, test } from "bun:test";
import { studioOriginNote } from "../src/web/scope.ts";

test("the studio origin note is drawn with §5 utilities, not .repo-lineage", () => {
  const note = String(
    studioOriginNote({
      origin: { htmlUrl: "https://github.com/a/arm", fullName: "a/arm", lastFetchAt: null },
    } as never),
  );
  expect(note).not.toContain("repo-lineage");
  expect(note).toContain("Reads from");
  expect(note).toContain('href="https://github.com/a/arm"');
  expect(note).toContain("break");
});

test("no page markup names repo-lineage", async () => {
  for (const f of ["chrome.ts", "scope.ts"]) {
    const src = await Bun.file(new URL(`../src/web/${f}`, import.meta.url)).text();
    expect(src).not.toContain("repo-lineage");
  }
});
