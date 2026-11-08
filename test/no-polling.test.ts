/**
 * No forge page reloads or refetches on a timer, beyond a named allowlist.
 * Pages learn of change from /events; a timer is allowed only where there is
 * no event to hear, and each such file says why here.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/** file -> the patterns it may carry, and why */
const ALLOWED: Record<string, { allow: string[]; why: string }> = {
  "src/web/sw.ts": { allow: ['http-equiv="refresh"'], why: "the restart page: the forge is down, so there is no /events to hear" },
  "src/web/pages/talk.ts": { allow: ["setInterval"], why: "server side: the stream of one turn watches the run's row, which has no event to hear" },
  "src/web/client.ts": { allow: ["data-live-every", "setInterval"], why: "the data-live-every mechanism itself, and clocks that only redraw text" },
};

const PATTERNS: [string, RegExp][] = [
  ["data-live-every", /data-live-every/],
  ["refresh: {", /refresh:\s*\{/],
  ['http-equiv="refresh"', /http-equiv=\\?["']refresh/],
  ["setInterval", /setInterval\s*\(/],
];

/** Names of the patterns a source text trips. */
export function timers(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Files in `files` that trip a pattern and are not allowlisted. */
export function offenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .map(([path, text]) => [path, timers(text).filter((t) => !ALLOWED[path]?.allow.includes(t))] as const)
    .filter(([, hits]) => hits.length > 0)
    .map(([path, hits]) => `${path}: ${hits.join(", ")}`);
}

async function webSources(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const path of new Glob("src/web/**/*.ts").scan(".")) {
    out[path] = await Bun.file(path).text();
  }
  return out;
}

describe("no polling in src/web", () => {
  test("no file outside the allowlist reloads or refetches on a timer", async () => {
    expect(offenders(await webSources())).toEqual([]);
  });

  test("every allowlisted file exists, says why, and still uses what it is allowed", async () => {
    const files = await webSources();
    for (const [path, { allow, why }] of Object.entries(ALLOWED)) {
      expect(path in files).toBe(true);
      expect(why.length).toBeGreaterThan(10);
      for (const p of allow) expect(timers(files[path]!)).toContain(p);
    }
  });

  test("a new timer reload in a fake file turns it red", () => {
    for (const bad of [
      '<p data-live-every="5">',
      "page({ refresh: { seconds: 3 } })",
      '<meta http-equiv="refresh" content="5">',
      "setInterval(() => location.reload(), 1000)",
    ]) {
      expect(offenders({ "src/web/pages/new.ts": bad })).toHaveLength(1);
    }
    expect(offenders({ "src/web/pages/new.ts": "const x = 1;" })).toEqual([]);
    expect(offenders({ "src/web/sw.ts": "http-equiv=\"refresh\"" })).toEqual([]);
    // an allowance covers only its own pattern
    expect(offenders({ "src/web/sw.ts": "setInterval(() => location.reload(), 1)" })).toHaveLength(1);
    expect(offenders({ "src/web/fleet-graph.ts": "refresh: { seconds: 1 }" })).toHaveLength(1);
  });
});
