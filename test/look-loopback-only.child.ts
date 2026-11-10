/**
 * Runs inside `unshare -rn` with only `lo` up (see look-loopback-only.test.ts):
 * serves a page on 127.0.0.1, takes a look of it with the real `takeLook`, and
 * prints exactly one line — `loopback-only look: png <bytes>` or
 * `loopback-only look: error <message>`.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { takeLook } from "../src/looks/capture.ts";

/** Raise `lo` with SIOCSIFFLAGS, so the namespace needs no `ip` binary. */
function loUp(): void {
  const libc = dlopen("libc.so.6", {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const fd = libc.socket(2, 2, 0);
  const req = new Uint8Array(40);
  req.set(new TextEncoder().encode("lo"));
  new DataView(req.buffer).setInt16(16, 1 | 8, true); // IFF_UP | IFF_LOOPBACK
  if (fd < 0 || libc.ioctl(fd, 0x8914n, ptr(req)) !== 0) throw new Error("could not raise lo");
}
loUp();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === "/away"
      ? Response.redirect("http://elsewhere.test:9/", 302)
      : new Response("<!doctype html><title>loopback</title><h1>loopback only</h1>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
const dir = mkdtempSync(join(tmpdir(), "look-lo-"));
const out = join(dir, "look.png");
let line: string;
let away: string;
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
  // A page that leaves the app's host is still refused in this namespace.
  const left = await takeLook({
    url: `http://127.0.0.1:${server.port}/away`,
    out: join(dir, "away.png"),
    width: 800,
    height: 600,
    timeoutMs: 20_000,
  });
  away = left.ok ? "png" : `refused ${left.error}`;
} catch (e) {
  away = "refused";
  line = `error ${e instanceof Error ? e.message : String(e)}`;
} finally {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`loopback-only look: ${line.replace(/\s+/g, " ").trim()}`);
console.log(`loopback-only away: ${away.replace(/\s+/g, " ").trim()}`);
process.exit(0);
