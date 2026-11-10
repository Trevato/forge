/**
 * Runs inside `unshare -rn` with only `lo` up (see look-loopback-only.test.ts):
 * serves a page on 127.0.0.1, takes a look of it with the real `takeLook`, and
 * prints exactly one line — `loopback-only look: png <bytes>` or
 * `loopback-only look: error <message>`.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLook } from "../src/looks/capture.ts";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response("<!doctype html><title>loopback</title><h1>loopback only</h1>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
const dir = mkdtempSync(join(tmpdir(), "look-lo-"));
const out = join(dir, "look.png");
let line: string;
try {
  const got = await takeLook({
    url: `http://127.0.0.1:${server.port}/`,
    out,
    width: 800,
    height: 600,
    timeoutMs: 20_000,
  });
  line = got.ok
    ? existsSync(out)
      ? `png ${statSync(out).size}`
      : "error no picture written"
    : `error ${got.error}`;
} catch (e) {
  line = `error ${e instanceof Error ? e.message : String(e)}`;
} finally {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`loopback-only look: ${line.replace(/\s+/g, " ").trim()}`);
process.exit(0);
