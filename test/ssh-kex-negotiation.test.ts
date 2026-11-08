/**
 * Key-exchange refusals in `src/ssh/transport.ts`. The transport sits on a
 * public port and promises to answer a bad exchange with a DISCONNECT and a
 * closed socket, never a throw. Driven directly with a recording host: the
 * OpenSSH client cannot be made to send these.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../src/kernel/log.ts";
import { loadOrCreateHostKey } from "../src/ssh/keys.ts";
import { serveSsh } from "../src/ssh/server.ts";
import { Transport } from "../src/ssh/transport.ts";
import { DISCONNECT, MSG } from "../src/ssh/wire.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const root = mkdtempSync(join(tmpdir(), "forge-ssh-kex-"));
const hostKey = loadOrCreateHostKey(join(root, "hostkey"));
const log = createLog("ssh-kex-test");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}
function str(value: Uint8Array | string): Uint8Array {
  const b = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concat(u32(b.length), b);
}
function frame(payload: Uint8Array): Uint8Array {
  let padding = (8 - ((5 + payload.length) % 8)) % 8;
  if (padding < 4) padding += 8;
  const length = 1 + payload.length + padding;
  const out = new Uint8Array(4 + length);
  new DataView(out.buffer).setUint32(0, length, false);
  out[4] = padding;
  out.set(payload, 5);
  out.set(randomBytes(padding), 5 + payload.length);
  return out;
}
function kexInit(algs: {
  kex: string[];
  hostKey?: string[];
  cipher?: string[];
}): Uint8Array {
  const cipher = algs.cipher ?? ["aes256-gcm@openssh.com"];
  return concat(
    new Uint8Array([MSG.KEXINIT]),
    randomBytes(16),
    str(algs.kex.join(",")),
    str((algs.hostKey ?? ["ssh-ed25519"]).join(",")),
    str(cipher.join(",")),
    str(cipher.join(",")),
    str("hmac-sha2-256"),
    str("hmac-sha2-256"),
    str("none"),
    str("none"),
    str(""),
    str(""),
    new Uint8Array([0]),
    u32(0),
  );
}
const ecdhInit = (point: Uint8Array) =>
  concat(new Uint8Array([MSG.KEX_ECDH_INIT]), str(point));

interface Seen {
  /** Plaintext packets the transport wrote: [type, ...]. */
  types: number[];
  disconnect?: { reason: number; text: string };
  closed?: string;
}

/** Parse the plaintext packets the transport wrote after its version line. */
function packets(out: Uint8Array): Uint8Array[] {
  const nl = out.indexOf(0x0a);
  let buf = out.subarray(nl + 1);
  const found: Uint8Array[] = [];
  while (buf.length >= 5) {
    const view = new DataView(buf.buffer, buf.byteOffset);
    const length = view.getUint32(0, false);
    if (buf.length < 4 + length) break;
    found.push(buf.subarray(5, 4 + length - buf[4]!));
    buf = buf.subarray(4 + length);
  }
  return found;
}

function exchange(frames: Uint8Array[]): Seen {
  const written: Uint8Array[] = [];
  const seen: Seen = { types: [] };
  const transport = new Transport(
    {
      write: (data) => written.push(data.slice()),
      payload: () => {},
      closed: (why) => {
        seen.closed = why;
      },
      log,
    },
    { hostKey, serverVersion: "SSH-2.0-forge" },
  );
  transport.start();
  transport.receive(new TextEncoder().encode("SSH-2.0-probe\r\n"));
  for (const f of frames) transport.receive(f);
  for (const p of packets(concat(...written))) {
    seen.types.push(p[0]!);
    if (p[0] === MSG.DISCONNECT) {
      const view = new DataView(p.buffer, p.byteOffset);
      const len = view.getUint32(5, false);
      seen.disconnect = {
        reason: view.getUint32(1, false),
        text: new TextDecoder().decode(p.subarray(9, 9 + len)),
      };
    }
  }
  return seen;
}

const good = kexInit({ kex: ["curve25519-sha256"] });

function expectRefused(seen: Seen, text: string): void {
  expect(seen.disconnect).toEqual({
    reason: DISCONNECT.KEY_EXCHANGE_FAILED,
    text,
  });
  expect(seen.closed).toBe(text);
  // No KEX_ECDH_REPLY: no shared secret was derived or used.
  expect(seen.types).not.toContain(MSG.KEX_ECDH_REPLY);
}

describe("ssh key exchange negotiation", () => {
  test("a client offering only algorithms the forge lacks is refused", () => {
    for (const offer of [
      { kex: ["diffie-hellman-group1-sha1"] },
      { kex: ["curve25519-sha256"], hostKey: ["ssh-dss"] },
      { kex: ["curve25519-sha256"], cipher: ["3des-cbc"] },
    ]) {
      expectRefused(exchange([frame(kexInit(offer))]), "no common algorithm");
    }
  });

  test("a Q_C of 31 or 33 bytes is refused", () => {
    for (const size of [0, 31, 33]) {
      expectRefused(
        exchange([frame(good), frame(ecdhInit(randomBytes(size)))]),
        "bad Q_C length",
      );
    }
  });

  test("an all-zero point and a low-order point are refused", () => {
    const points = [
      new Uint8Array(32),
      // order 1, order 2, and order 8 points of curve25519
      Uint8Array.from([1, ...new Array(31).fill(0)]),
      Buffer.from(
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
        "hex",
      ),
      Buffer.from(
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        "hex",
      ),
    ];
    for (const point of points) {
      expectRefused(
        exchange([frame(good), frame(ecdhInit(point))]),
        "invalid client point",
      );
    }
  });

  test("a refused exchange closes the socket and the next connection is served", async () => {
    const server = await serveSsh({
      port: 0,
      hostname: "127.0.0.1",
      hostKeyDir: join(root, "listener"),
      log,
      authorize: () => true,
      onSession: () => {},
    });
    try {
      const attempt = (frames: Uint8Array[]) =>
        new Promise<{ closed: boolean; bytes: Uint8Array }>((resolve) => {
          const got: Uint8Array[] = [];
          let served = false;
          void Bun.connect({
            hostname: "127.0.0.1",
            port: server.port,
            socket: {
              open(s) {
                s.write(new TextEncoder().encode("SSH-2.0-probe\r\n"));
                for (const f of frames) s.write(f);
              },
              data(s, chunk) {
                got.push(chunk.slice());
                if (frames.length === 0) {
                  served = true;
                  s.end();
                  resolve({ closed: false, bytes: concat(...got) });
                }
              },
              close: () => {
                if (!served) resolve({ closed: true, bytes: concat(...got) });
              },
              error: () => resolve({ closed: true, bytes: concat(...got) }),
            },
          });
        });
      const bad = [
        [frame(kexInit({ kex: ["nope"] }))],
        [frame(good), frame(ecdhInit(randomBytes(31)))],
        [frame(good), frame(ecdhInit(new Uint8Array(32)))],
      ];
      for (const frames of bad) {
        const refused = await attempt(frames);
        expect(refused.closed).toBe(true);
        expect(packets(refused.bytes).map((p) => p[0])).toContain(
          MSG.DISCONNECT,
        );
      }
      const next = await attempt([]);
      expect(next.closed).toBe(false);
      expect(new TextDecoder().decode(next.bytes)).toStartWith("SSH-2.0-forge");
    } finally {
      server.stop();
    }
  });
});
