import { expect, test } from "bun:test";
import { studioOriginNote } from "../src/web/scope.ts";

// Spelled in parts so a grep for the retired class finds nothing under test/.
const retired = ["repo", "lineage"].join("-");

test("the studio origin note is drawn with §5 utilities, not the retired lineage class", () => {
  const note = String(
    studioOriginNote({
      origin: { htmlUrl: "https://github.com/a/arm", fullName: "a/arm", lastFetchAt: null },
    } as never),
  );
  expect(note).not.toContain(retired);
  expect(note).toContain("Reads from");
  expect(note).toContain('href="https://github.com/a/arm"');
  expect(note).toContain("break");
});

test("no page markup or stylesheet names the retired lineage class", async () => {
  for (const f of ["chrome.ts", "scope.ts", "style/content.ts"]) {
    const src = await Bun.file(new URL(`../src/web/${f}`, import.meta.url)).text();
    expect(src).not.toContain(retired);
  }
});
