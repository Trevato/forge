/**
 * The door's limits, before any key work: past the global cap, the
 * per-address cap and the handshake rate a connection is refused with a line
 * of text and closed — no version line, no KEXINIT, no signature.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../src/kernel/log.ts";
import { addressKey, ConnectionLimits, DEFAULT_LIMITS, type SshLimitValues } from "../src/ssh/limits.ts";
import { serveSsh, type SshServer } from "../src/ssh/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("ConnectionLimits", () => {
  const small = { maxConnections: 3, maxPerAddress: 2, handshakesPerAddress: 100, handshakes: 100, windowMs: 1000 };

  test("the global cap refuses, and a release makes room", () => {
    const l = new ConnectionLimits(small);
    const a = l.admit("10.0.0.1", 0);
    l.admit("10.0.0.2", 0);
    l.admit("10.0.0.3", 0);
    expect(l.admit("10.0.0.4", 0)).toEqual({ refused: "too many connections" });
    if ("key" in a) l.release(a.key);
    expect("key" in l.admit("10.0.0.4", 0)).toBe(true);
  });

  test("the per-address cap refuses one address and not another", () => {
    const l = new ConnectionLimits(small);
    l.admit("10.0.0.1", 0);
    l.admit("10.0.0.1", 0);
    expect(l.admit("10.0.0.1", 0)).toEqual({ refused: "too many from this address" });
    expect("key" in l.admit("10.0.0.2", 0)).toBe(true);
  });

  test("the handshake rate refuses per address and overall, then recovers with the window", () => {
    const l = new ConnectionLimits({ maxConnections: 100, maxPerAddress: 100, handshakesPerAddress: 2, handshakes: 3, windowMs: 1000 });
    for (const t of [0, 1]) {
      const v = l.admit("10.0.0.1", t);
      if ("key" in v) l.release(v.key);
    }
    expect(l.admit("10.0.0.1", 2)).toEqual({ refused: "too many handshakes" });
    expect("key" in l.admit("10.0.0.2", 3)).toBe(true);
    expect(l.admit("10.0.0.3", 4)).toEqual({ refused: "too many handshakes" });
    expect("key" in l.admit("10.0.0.1", 1500)).toBe(true);
  });

  test("an IPv6 address is limited by its /64", () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe(addressKey("2001:db8:1:2:bbbb::9"));
    expect(addressKey("2001:db8:1:3::1")).not.toBe(addressKey("2001:db8:1:2::1"));
    expect(addressKey("10.0.0.1")).toBe("10.0.0.1");
  });

  test("the defaults are bounded", () => {
    expect(DEFAULT_LIMITS.maxPerAddress).toBeLessThan(DEFAULT_LIMITS.maxConnections);
    expect(DEFAULT_LIMITS.handshakesPerAddress).toBeLessThan(DEFAULT_LIMITS.handshakes);
  });
});

describe("the listener", () => {
  const roots: string[] = [];
  let server: SshServer | undefined;
  afterEach(() => {
    server?.stop();
    server = undefined;
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  async function listen(limits: Partial<SshLimitValues>) {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ssh-limits-"));
    roots.push(dir);
    server = await serveSsh({
      port: 0,
      hostname: "127.0.0.1",
      hostKeyDir: dir,
      log: createLog("ssh-limits"),
      authorize: () => true,
      onSession: () => {},
      limits,
    });
    return server;
  }

  /** Open a connection, say nothing, and report what the server sent first. */
  function open(port: number): Promise<{ first: string; closed: Promise<void>; end(): void }> {
    return new Promise((resolve, reject) => {
      let first = "";
      let seen = false;
      let closedNow: () => void = () => {};
      const closed = new Promise<void>((r) => (closedNow = r));
      let sock: Bun.Socket | undefined;
      const settle = () => {
        if (seen) return;
        seen = true;
        resolve({ first, closed, end: () => sock?.end() });
      };
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) { sock = s; setTimeout(settle, 150); /* real-timer: wait for a banner that must not come */ },
          data(_s, d) { first += new TextDecoder().decode(d); },
          close() { closedNow(); settle(); },
          error() { closedNow(); settle(); },
        },
      }).catch(reject);
    });
  }

  const refusal = /too many/;

  test("past the global cap the next connection is refused with no handshake", async () => {
    const s = await listen({ maxConnections: 2, maxPerAddress: 100, handshakesPerAddress: 100, handshakes: 100 });
    const held = [await open(s.port), await open(s.port)];
    for (const h of held) expect(h.first.startsWith("SSH-2.0-")).toBe(true);
    const refused = await open(s.port);
    expect(refused.first).toMatch(refusal);
    expect(refused.first).not.toContain("SSH-2.0-");
    await refused.closed;
    expect(s.sessions()).toBe(2);
    held[0]!.end();
    await held[0]!.closed;
    await Bun.sleep(50); // real-timer: the server frees a closed socket on its own loop turn
    expect((await open(s.port)).first.startsWith("SSH-2.0-")).toBe(true);
  });

  test("past the per-address cap the next connection from that address is refused", async () => {
    const s = await listen({ maxConnections: 100, maxPerAddress: 2, handshakesPerAddress: 100, handshakes: 100 });
    await open(s.port);
    await open(s.port);
    const refused = await open(s.port);
    expect(refused.first).toMatch(/from this address/);
    expect(refused.first).not.toContain("SSH-2.0-");
    expect(s.sessions()).toBe(2);
  });

  test("past the handshake rate the next connection is refused, though none is open", async () => {
    const s = await listen({ maxConnections: 100, maxPerAddress: 100, handshakesPerAddress: 3, handshakes: 100, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      const c = await open(s.port);
      expect(c.first.startsWith("SSH-2.0-")).toBe(true);
      c.end();
      await c.closed;
    }
    await Bun.sleep(50); // real-timer: the server frees a closed socket on its own loop turn
    const refused = await open(s.port);
    expect(refused.first).toMatch(/too many handshakes/);
    expect(refused.first).not.toContain("SSH-2.0-");
  });
});
