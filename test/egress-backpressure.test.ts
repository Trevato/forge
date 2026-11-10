/**
 * A client that reads slower than its upstream sends gets every byte (an
 * install extracting a large tarball while the registry streams it): the
 * proxy pauses the upstream while the client's backlog is full instead of
 * cutting the connection, so the download is never truncated.
 */

import { afterEach, expect, test } from "bun:test";
import type { Socket } from "bun";
import { startEgress } from "../src/apps/egress.ts";

const pending: (() => void)[] = [];
afterEach(() => {
  while (pending.length > 0) pending.pop()?.();
});

const SIZE = 8 * 1024 * 1024;

/** A server that answers any request with `SIZE` bytes as fast as the socket takes them, then closes. */
function bulk() {
  const body = new Uint8Array(SIZE).fill(120);
  const server = Bun.listen<{ at: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { at: 0 };
      },
      data(s) {
        pump(s);
      },
      drain(s) {
        pump(s);
      },
    },
  });
  function pump(s: Socket<{ at: number }>) {
    while (s.data.at < SIZE) {
      const n = s.write(body.subarray(s.data.at));
      if (n <= 0) return;
      s.data.at += n;
    }
    s.end();
  }
  pending.push(() => server.stop(true));
  return server.port;
}

test("a slow reader gets all 8 MiB through a 256 KiB backlog", async () => {
  const port = bulk();
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const listen = probe.port;
  probe.stop(true);
  const egress = startEgress(
    { tcp: listen },
    { hosts: [], origins: [{ host: "127.0.0.1", port }], label: `bp${listen}`, queueMax: 256 * 1024 },
  );
  pending.push(() => egress.close());
  const done = Promise.withResolvers<void>();
  let head = "";
  let body = 0;
  const sock = await Bun.connect<undefined>({
    hostname: "127.0.0.1",
    port: listen,
    socket: {
      data(s, chunk) {
        if (!head.includes("\r\n\r\n")) {
          head += new TextDecoder().decode(chunk);
          const at = head.indexOf("\r\n\r\n");
          if (at === -1) return;
          body += head.length - at - 4;
          // Stop reading for a while, as an install busy extracting does.
          s.pause();
          setTimeout(() => s.resume(), 400);
          return;
        }
        body += chunk.length;
      },
      close: () => done.resolve(),
      error: () => done.resolve(),
    },
  });
  sock.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\nGET /\r\n\r\n`);
  await done.promise;
  expect(body).toBe(SIZE);
}, 20_000);
