/**
 * Loaded before every test file (`bunfig.toml` `[test] preload`), never by
 * the forge. Only what the whole suite must agree on belongs here.
 */

import { installCheapHash } from "./cheap-hash.ts";

installCheapHash();
