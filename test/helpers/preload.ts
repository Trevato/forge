/**
 * Loaded before every test file (`bunfig.toml` `[test] preload`), never by
 * the forge. Only what the whole suite must agree on belongs here.
 */

import { installCheapHash } from "./cheap-hash.ts";

installCheapHash();

// Most suites make plain accounts and expect them to own things; the guest
// guard (`guard_guests`, on in production) has its own suite that turns it on.
process.env["FORGE_GUARD_GUESTS"] = "off";
