/**
 * Loaded before every test file (`bunfig.toml` `[test] preload`), never by
 * the forge. Only what the whole suite must agree on belongs here.
 */

import { provideCpusForTest } from "../../src/core/capacity.ts";
import { provideMirrorOutboundForTest } from "../../src/origins/git-mirror.ts";
import { installCheapHash } from "./cheap-hash.ts";
import { useReachByDefault } from "../../src/spawn/reach.ts";
import { servedWindow } from "../../src/spawn/clients.ts";
import "./roomy-disk.ts";

installCheapHash();
// Defaults sized from CPUs (#2549) read as on a 4-CPU pod — 4 shards, one
// check at once — whatever machine runs the suite.
provideCpusForTest(4);
// Suites mirror from fake origins on loopback; the refusal itself is proved
// in mirror-outbound.test.ts, which turns this off.
provideMirrorOutboundForTest({ allow: ["127.0.0.1", "::1"] });

// Loopback is reachable for origin discovery only in dev (#2993); the suite
// serves its fake forges from this machine.
process.env.FORGE_DEV = "1";

// A suite has no public network to prove a child through (`spawn/reach.ts`); a test of reach injects its own fetch.
useReachByDefault({ off: true });

// The /forges list is served from memory in production; a test reads what it just changed (`spawn/clients.ts`).
servedWindow.ms = 0;

// `FORGE_SQL_LOG=<file>`: each distinct statement the run prepares, for
// `scripts/index-use.ts --log` (#12011). Off unless asked for.
if (process.env.FORGE_SQL_LOG) {
  const { Database } = await import("bun:sqlite");
  const { collectInto } = await import("../../scripts/index-use.ts");
  const note = collectInto(process.env.FORGE_SQL_LOG);
  const proto = Database.prototype as unknown as Record<"query" | "prepare", (sql: string, ...rest: unknown[]) => unknown>;
  for (const method of ["query", "prepare"] as const) {
    const original = proto[method];
    proto[method] = function (this: unknown, sql: string, ...rest: unknown[]) {
      if (typeof sql === "string") note(sql);
      return original.call(this, sql, ...rest);
    };
  }
}
