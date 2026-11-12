/** One issue per cause (#7558): a comment while it stands, never a second issue. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { HOUR_MS } from "../src/efficiency/baseline.ts";
import { quietLogs } from "./helpers/globals.ts";
import { commentsOf, forge, flat, issuesOf, MiB, NPM, seed, T0, watch } from "./helpers/efficiency.ts";

quietLogs();
let f: Awaited<ReturnType<typeof forge>>;
beforeAll(async () => { f = await forge(); });
afterAll(() => f.done());

test("a cost that stays bad gets one issue and one comment per hour", () => {
  flat(f.app, T0);
  const bad = { [NPM]: 600 * MiB };
  watch(f.app, T0 + 600_000, bad);
  watch(f.app, T0 + HOUR_MS + 600_000, bad); // files
  watch(f.app, T0 + HOUR_MS + 1_200_000, bad); // same hour again: nothing more
  watch(f.app, T0 + 2 * HOUR_MS + 600_000, bad);
  watch(f.app, T0 + 3 * HOUR_MS + 600_000, bad);
  const issues = issuesOf(f.app, f.repoId);
  expect(issues).toHaveLength(1);
  const notes = commentsOf(f.app, issues[0]!.id);
  expect(notes).toHaveLength(2);
  expect(notes[0]).toContain("Still bad");
  expect(notes[0]).toContain("600.00 MiB");
});

test("another cause files its own issue; a person's close makes the next finding a new issue", () => {
  f.app.db.exec("DELETE FROM efficiency_sample; DELETE FROM efficiency_finding; DELETE FROM comment; DELETE FROM issue");
  const OTHER = "egress-other-bytes";
  flat(f.app, T0);
  seed(f.app, OTHER, T0, 8 * 24, () => 100 * MiB);
  const second = { [NPM]: 600 * MiB, [OTHER]: 5 * 1024 * MiB };
  for (let h = 0; h <= 1; h++) watch(f.app, T0 + h * HOUR_MS + 600_000, second);
  const issues = issuesOf(f.app, f.repoId);
  expect(issues).toHaveLength(2);
  expect(issues.filter((i) => i.title.includes("npm registry bytes"))).toHaveLength(1);
  expect(issues.filter((i) => i.title.includes("every other destination"))).toHaveLength(1);
  f.app.db.exec("UPDATE issue SET state = 'closed' WHERE title LIKE '%npm registry bytes%'");
  watch(f.app, T0 + 2 * HOUR_MS + 600_000, second);
  expect(issuesOf(f.app, f.repoId).filter((i) => i.title.includes("npm registry bytes"))).toHaveLength(2);
  expect(issuesOf(f.app, f.repoId).filter((i) => i.title.includes("every other destination") && i.state === "open")).toHaveLength(1);
});
