/** The runtime is chosen, not floated (#3803): every Bun base image names MAJOR.MINOR.PATCH. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const froms = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => /^\s*FROM\s+oven\/bun[:@\s]/i.test(l) || /^\s*FROM\s+oven\/bun$/i.test(l));

test("the Dockerfile uses a Bun base image", () => {
  expect(froms.length).toBeGreaterThan(0);
});

test("every oven/bun tag is an exact patch release", () => {
  for (const line of froms) {
    expect(line).toMatch(/^\s*FROM\s+oven\/bun:\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\s+AS\s+\S+)?\s*$/i);
  }
});
