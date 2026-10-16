import { expect, test } from "bun:test";
import { checksLine } from "../src/web/pages/pull.ts";

const ok = { state: "ok", run: null } as const;

test("a conflicted pull with a passing check has no green mark and says so", () => {
  const line = checksLine("/a/b", ok, false, true, false, "", "", 2).text;
  expect(line).not.toContain('class="ok"');
  expect(line).toContain("Conflicts in 2 files");
  expect(line).not.toContain("Check passed");
  expect(checksLine("/a/b", ok, false, true, false, "", "", 1).text).toContain(
    "Conflicts in 1 file</span",
  );
});

test("resolving the conflict brings the green back", () => {
  const line = checksLine("/a/b", ok, false, true, false, "", "", 0).text;
  expect(line).toContain('class="ok"');
  expect(line).toContain("Check passed");
  expect(line).not.toContain("Conflicts in");
});
