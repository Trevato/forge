/**
 * The egress proxy never leaves an upstream socket open after the cell side
 * is gone (#3719): a client that drops, a proxy that closes, a client that
 * stops reading, and a cap on connections to one destination.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Socket } from "bun";
import { egressSnapshot, relay, startEgress } from "../src/apps/egress.ts";

const openNow = (label: string, destination?: string): number =>
  egressSnapshot()
    .filter((r) => r.label === label && (destination === undefined || r.destination === destination))
    .reduce((n, r) => n + r.open, 0);

const pending: (() => void)[] = [];
afterEach(() => {
  while (pending.length > 0) pending.pop()?.();
});

/** A fake MJPEG camera: streams forever, counts live connections. */
function camera(frame = 1024) {
  const open = new Set<Socket<undefined>>();
  // Half-open allowed: like a real camera, it keeps streaming after the
  // other side has said it is done writing, until the socket is destroyed.
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    allowHalfOpen: true,
    socket: {
      open(s) {
        open.add(s);
        s.data = undefined;
      },
      data(s) {
        const timer = setInterval(() => {
          if (!open.has(s)) return clearInterval(timer);
          s.write("--frame\r\n" + "x".repeat(frame) + "\r\n");
        }, 5);
      },
      close(s) {
        open.delete(s);
      },
      error(s) {
        open.delete(s);
      },
    },
  });
  pending.push(() => server.stop(true));
  return { port: server.port, count: () => open.size };
}

async function until(check: () => boolean, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

describe("egress leaves nothing open", () => {
  // Bun.listen with port 0 gives no handle back through `startEgress`, so
  // these tests listen on a fixed free port found first.
  async function freePort(): Promise<number> {
    const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const p = s.port;
    s.stop(true);
    return p;
  }

  async function setup(extra: Record<string, unknown> = {}, frame = 1024, log?: (line: string) => void) {
    const cam = camera(frame);
    const listen = await freePort();
    const egress = startEgress(
      { tcp: listen },
      {
        hosts: [],
        origins: [{ host: "127.0.0.1", port: cam.port }],
        label: `t${listen}`,
        ...extra,
      },
      log,
    );
    pending.push(() => egress.close());
    const stream = async (request = true, hold = false) => {
      const got = Promise.withResolvers<string>();
      let text = "";
      const sock = await Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port: listen,
        socket: {
          data(_s, chunk) {
            text += new TextDecoder().decode(chunk);
            if (text.includes("200 Connection Established")) got.resolve(text);
          },
          close() {},
          error() {},
        },
      });
      sock.write(`CONNECT 127.0.0.1:${cam.port} HTTP/1.1\r\n\r\n${request ? "GET /\r\n\r\n" : ""}`);
      await got.promise;
      if (hold) sock.pause();
      return sock;
    };
    return { cam, egress, stream, listen, label: `t${listen}`, dest: `127.0.0.1:${cam.port}` };
  }

  test("a client that disconnects mid-stream closes its upstream", async () => {
    const { cam, stream } = await setup();
    const sock = await stream();
    expect(await until(() => cam.count() === 1)).toBe(true);
    sock.terminate();
    expect(await until(() => cam.count() === 0)).toBe(true);
  });

  test("closing the proxy (the cell stops) leaves 0 of 20 streams open", async () => {
    const { cam, egress, stream, label } = await setup({ maxPerDestination: 20 });
    const socks = await Promise.all(Array.from({ length: 20 }, () => stream()));
    expect(await until(() => cam.count() === 20)).toBe(true);
    expect(openNow(label)).toBe(20);
    egress.close();
    expect(await until(() => cam.count() === 0)).toBe(true);
    expect(openNow(label)).toBe(0);
    for (const s of socks) s.terminate();
  });

  test("clients that drop right after connecting leave no upstream behind", async () => {
    const { cam, stream } = await setup({ maxPerDestination: 10 });
    const socks = await Promise.all(Array.from({ length: 10 }, () => stream()));
    for (const s of socks) s.terminate();
    expect(await until(() => cam.count() === 0, 3_000)).toBe(true);
  });

  test("connections past the per-destination cap are refused, and counted", async () => {
    const lines: string[] = [];
    const { cam, stream, listen, label, dest } = await setup({ maxPerDestination: 2 }, 1024, (l) => lines.push(l));
    const a = await stream();
    const b = await stream();
    expect(await until(() => cam.count() === 2)).toBe(true);
    let reply = "";
    const third = await Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port: listen,
      socket: {
        data(_s, chunk) {
          reply += new TextDecoder().decode(chunk);
        },
      },
    });
    third.write(`CONNECT 127.0.0.1:${cam.port} HTTP/1.1\r\n\r\n`);
    expect(await until(() => reply.startsWith("HTTP/1.1 429"))).toBe(true);
    expect(lines.some((l) => l.startsWith("egress capped:") && l.includes(dest))).toBe(true);
    expect(cam.count()).toBe(2);
    expect(openNow(label, dest)).toBe(2);
    const row = egressSnapshot().find((r) => r.label === label && r.destination === dest);
    expect(row?.open).toBe(2);
    expect(row?.bytesIn).toBeGreaterThan(0);
    a.terminate();
    b.terminate();
    expect(await until(() => openNow(label, dest) === 0)).toBe(true);
    // Nothing of a closed app stays in the tally.
    expect(egressSnapshot().some((r) => r.label === label)).toBe(false);
  });

  test("a connection that moves no bytes is cut after the idle timeout", async () => {
    const { cam, stream } = await setup({ idleMs: 150 });
    const sock = await stream(false);
    expect(await until(() => cam.count() === 1)).toBe(true);
    expect(await until(() => cam.count() === 0)).toBe(true);
    sock.terminate();
  });

  test("a client that stops reading pauses its upstream, then is cut at the idle timeout", async () => {
    const { cam, stream } = await setup({ queueMax: 64 * 1024, idleMs: 300 }, 32 * 1024);
    const sock = await stream(true, true);
    expect(await until(() => cam.count() === 0, 5_000)).toBe(true);
    sock.terminate();
  });
});

describe("the inbound and loopback relay closes its target with the client", () => {
  test("a client that leaves mid-stream closes the connection it was relayed to", async () => {
    const cam = camera();
    const find = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = find.port;
    find.stop(true);
    const r = relay({ tcp: port }, { tcp: cam.port });
    pending.push(() => r.close());
    let seen = 0;
    const client = await Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port,
      socket: { data: (_s, c) => void (seen += c.length) },
    });
    client.write("go");
    expect(await until(() => cam.count() === 1 && seen > 0)).toBe(true);
    client.terminate();
    expect(await until(() => cam.count() === 0)).toBe(true);
  });
});

describe("a client that leaves while the dial is in flight", () => {
  test("strands no upstream and leaves nothing in the tally", async () => {
    const cam = camera();
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const listen = probe.port;
    probe.stop(true);
    const label = `dial${listen}`;
    const egress = startEgress(
      { tcp: listen },
      { hosts: [], origins: [{ host: "127.0.0.1", port: cam.port }], label, maxPerDestination: 1000 },
    );
    pending.push(() => egress.close());
    // The dial is a few ticks long: leave at each of several moments inside it.
    const socks: Socket<undefined>[] = [];
    for (let i = 0; i < 60; i++) {
      const sock = await Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port: listen,
        socket: { data() {}, close() {}, error() {} },
      });
      sock.write(`CONNECT 127.0.0.1:${cam.port} HTTP/1.1\r\n\r\n`);
      socks.push(sock);
      if (i % 3 > 0) await Bun.sleep(i % 3 - 1);
      sock.terminate();
    }
    expect(await until(() => cam.count() === 0, 3_000)).toBe(true);
    expect(await until(() => !egressSnapshot().some((r) => r.label === label), 3_000)).toBe(true);
  });
});
