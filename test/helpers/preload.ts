/**
 * Loaded before every test file (`bunfig.toml` `[test] preload`), never by
 * the forge. Only what the whole suite must agree on belongs here.
 */

import { provideCpusForTest } from "../../src/core/capacity.ts";
import { installCheapHash } from "./cheap-hash.ts";

installCheapHash();
// Defaults sized from CPUs (#2549) read as on a 4-CPU pod — 4 shards, one
// check at once — whatever machine runs the suite.
provideCpusForTest(4);
// Loopback is reachable for origin discovery only in dev (#2993); the suite
// serves its fake forges from this machine.
process.env.FORGE_DEV = "1";
