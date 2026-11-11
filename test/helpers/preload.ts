/**
 * Loaded before every test file (`bunfig.toml` `[test] preload`), never by
 * the forge. Only what the whole suite must agree on belongs here.
 */

import { provideCpusForTest } from "../../src/core/capacity.ts";
import { provideMirrorOutboundForTest } from "../../src/origins/git-mirror.ts";
import { installCheapHash } from "./cheap-hash.ts";
import { useReachByDefault } from "../../src/spawn/reach.ts";
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
