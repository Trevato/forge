/** Closing (#7558): back under for 24 hours closes the issue with a note; sooner does not. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { HOUR_MS } from "../src/efficiency/baseline.ts";
import { quietLogs } from "./helpers/globals.ts";
import { commentsOf, forge, flat, issuesOf, MiB, NPM, T0, watch } from "./helpers/efficiency.ts";

quietLogs();
let f: Awaited<ReturnType<typeof forge>>;
beforeAll(async () => { f = await forge(); });
afterAll(() => f.done());

test("closed with a note after 24 hours back under, not before; a relapse resets the clock", () => {
  flat(f.app, T0);
  const bad = { [NPM]: 600 * MiB };
  const ok = { [NPM]: 50 * MiB };
  watch(f.app, T0 + 600_000, bad);
  watch(f.app, T0 + HOUR_MS + 600_000, bad); // files; last bad hour is T0+1h
  const [issue] = issuesOf(f.app, f.repoId);
  expect(issue!.state).toBe("open");
  watch(f.app, T0 + 2 * HOUR_MS + 600_000, ok);
  watch(f.app, T0 + 20 * HOUR_MS + 600_000, ok);
  expect(issuesOf(f.app, f.repoId)[0]!.state).toBe("open");
  watch(f.app, T0 + 25 * HOUR_MS + 300_000, ok); // 24 h after the last bad hour
  const after = issuesOf(f.app, f.repoId)[0]!;
  expect(after.state).toBe("closed");
  expect(commentsOf(f.app, issue!.id).at(-1)).toContain("back under");
  expect(commentsOf(f.app, issue!.id).at(-1)).toContain("24 hours");
});

test("a single bad hour inside the 24 resets the wait: closing comes 24 hours after it, not before", () => {
  f.app.db.exec("DELETE FROM efficiency_sample; DELETE FROM efficiency_finding; DELETE FROM comment; DELETE FROM issue");
  const base = T0 + 40 * HOUR_MS;
  flat(f.app, base);
  const bad = { [NPM]: 600 * MiB };
  const ok = { [NPM]: 50 * MiB };
  watch(f.app, base + 600_000, bad);
  watch(f.app, base + HOUR_MS + 600_000, bad); // files; last bad hour is base+1h
  watch(f.app, base + 10 * HOUR_MS + 600_000, bad); // a stray bad hour, alone: last bad hour is base+10h
  watch(f.app, base + 26 * HOUR_MS + 600_000, ok); // 25 h after base+1h: would close had the stray done nothing
  expect(issuesOf(f.app, f.repoId)[0]!.state).toBe("open");
  watch(f.app, base + 33 * HOUR_MS + 600_000, ok); // 23 h 10 min after the stray hour
  expect(issuesOf(f.app, f.repoId)[0]!.state).toBe("open");
  watch(f.app, base + 34 * HOUR_MS + 300_000, ok); // 24 h 5 min after the stray hour
  expect(issuesOf(f.app, f.repoId)[0]!.state).toBe("closed");
});
