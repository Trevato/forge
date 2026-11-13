/**
 * Fuzzing the SSH door's own protocol code: random and mutated bytes into the
 * wire primitives and into a pre-auth transport. Nothing throws past the
 * connection, the unauthenticated queue never holds more than the RFC 4253
 * §6.1 35 000-byte packet, and a stream that stays bad always ends in a
 * DISCONNECT. Seeded: a failure names the seed (`FUZZ_SEED=<n>` reruns it).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../src/kernel/log.ts";
import { loadOrCreateHostKey } from "../src/ssh/keys.ts";
import { Transport } from "../src/ssh/transport.ts";
import { ByteQueue, concat, MSG, Reader, WireError, Writer } from "../src/ssh/wire.ts";
import { quietLogs } from "./helpers/globals.ts";
import { int, rng, SEED, type Rand } from "./helpers/fuzz.ts";

quietLogs();

const RUNS = Number(process.env["FUZZ_RUNS"] ?? 300);
const CAP = 35_000;
const hostKey = loadOrCreateHostKey(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ssh-fuzz-")));

const bytes = (r: Rand, n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(r, 256));

/** Flip, drop, insert and overwrite bytes: a valid packet turned slightly wrong. */
function mutate(r: Rand, input: Uint8Array): Uint8Array {
  const out = Array.from(input);
  for (let n = int(r, 6) + 1; n > 0; n--) {
    const at = int(r, out.length + 1);
    switch (int(r, 4)) {
      case 0: out[at] = (out[at] ?? 0) ^ (1 << int(r, 8)); break;
      case 1: out.splice(at, 1 + int(r, 4)); break;
      case 2: out.splice(at, 0, ...bytes(r, 1 + int(r, 8))); break;
      default: out[at] = int(r, 256);
    }
  }
  return Uint8Array.from(out);
}

/** A plaintext binary packet (RFC 4253 §6) around `payload`. */
function packet(payload: Uint8Array): Uint8Array {
  let pad = (8 - ((5 + payload.length) % 8)) % 8;
  if (pad < 4) pad += 8;
  const length = 1 + payload.length + pad;
  const out = new Uint8Array(4 + length);
  new DataView(out.buffer).setUint32(0, length);
  out[4] = pad;
  out.set(payload, 5);
  return out;
}

const KEXINIT = new Writer(512)
  .u8(MSG.KEXINIT).raw(new Uint8Array(16))
  .nameList(["curve25519-sha256", "kex-strict-c-v00@openssh.com"])
  .nameList(["ssh-ed25519"])
  .nameList(["aes256-gcm@openssh.com"]).nameList(["aes256-gcm@openssh.com"])
  .nameList(["hmac-sha2-256"]).nameList(["hmac-sha2-256"])
  .nameList(["none"]).nameList(["none"])
  .nameList([]).nameList([])
  .bool(false).u32(0)
  .build();

const VERSION = new TextEncoder().encode("SSH-2.0-fuzz\r\n");

function harness() {
  const out: Uint8Array[] = [];
  const closed: string[] = [];
  const faults: string[] = [];
  const transport = new Transport(
    {
      write: (d) => out.push(d.slice()),
      payload: () => {},
      closed: (why) => closed.push(why),
      log: { ...createLog("ssh-fuzz"), error: (m: string) => void faults.push(m) } as ReturnType<typeof createLog>,
    },
    { hostKey, serverVersion: "SSH-2.0-forge-fuzz" },
  );
  transport.start();
  const queued = (): number => (transport as unknown as { q: ByteQueue }).q.size;
  const wroteDisconnect = (): boolean => {
    const all = concat(...out);
    // A DISCONNECT is a plaintext packet whose payload starts with MSG.DISCONNECT.
    for (let at = all.indexOf(0x0a) + 1; at + 6 <= all.length; ) {
      const len = new DataView(all.buffer, all.byteOffset + at).getUint32(0);
      if (all[at + 5] === MSG.DISCONNECT) return true;
      at += 4 + len;
    }
    return false;
  };
  return { transport, closed, faults, queued, wroteDisconnect };
}

describe("wire primitives", () => {
  test("a Reader over random bytes throws only WireError", () => {
    const r = rng(SEED);
    for (let i = 0; i < RUNS * 4; i++) {
      const reader = new Reader(bytes(r, int(r, 64)));
      try {
        for (let n = 0; n < 8; n++) {
          [() => reader.u8(), () => reader.u32(), () => reader.string(), () => reader.nameList(), () => reader.bool(), () => reader.bytes(int(r, 100))][int(r, 6)]!();
        }
        reader.end();
      } catch (e) {
        expect(e).toBeInstanceOf(WireError);
      }
    }
  });

  test("a ByteQueue holds exactly what was pushed, whatever the chunking", () => {
    const r = rng(SEED + 1);
    for (let i = 0; i < RUNS; i++) {
      const q = new ByteQueue();
      const all: number[] = [];
      for (let n = int(r, 12); n > 0; n--) {
        const chunk = bytes(r, int(r, 3000));
        q.push(chunk);
        all.push(...chunk);
        const skip = int(r, q.size + 1);
        all.splice(0, skip);
        q.skip(skip);
        expect(q.size).toBe(all.length);
      }
      expect(Array.from(q.peek(q.size))).toEqual(all);
    }
  });
});

describe("pre-auth transport", () => {
  test("random and mutated packets never throw, never queue past the cap, and end in a disconnect", () => {
    const r = rng(SEED + 2);
    for (let i = 0; i < RUNS; i++) {
      const h = harness();
      const stream: Uint8Array[] = [VERSION];
      for (let n = int(r, 5); n > 0; n--) {
        const kind = int(r, 4);
        stream.push(
          kind === 0 ? bytes(r, int(r, 300))
          : kind === 1 ? mutate(r, packet(KEXINIT))
          : kind === 2 ? packet(bytes(r, int(r, 200)))
          : mutate(r, packet(new Writer(64).u8(MSG.KEX_ECDH_INIT).string(bytes(r, int(r, 40))).build())),
        );
      }
      // Whatever is half-sent is finished by this: past 35 000 bytes the next
      // length header is 0xFFFFFFFF, which must end the connection.
      stream.push(new Uint8Array(CAP + 8).fill(0xff));
      for (const part of stream) {
        for (let at = 0; at < part.length && h.closed.length === 0; at += 4096) {
          expect(() => h.transport.receive(part.subarray(at, at + 4096))).not.toThrow();
          if (h.closed.length === 0) expect(h.queued()).toBeLessThanOrEqual(CAP + 4);
        }
      }
      expect(h.faults).toEqual([]);
      expect(h.closed.length).toBe(1);
    }
  });

  test("a version line is accepted whole or refused, never grown without bound", () => {
    const r = rng(SEED + 3);
    for (let i = 0; i < RUNS; i++) {
      const h = harness();
      for (let n = 0; n < 40 && h.closed.length === 0; n++) {
        const noise = bytes(r, 1 + int(r, 200)).map((b) => (b === 0x0a ? 0x20 : b));
        h.transport.receive(noise);
        expect(h.queued()).toBeLessThanOrEqual(1024 + 256);
      }
      expect(h.closed.length).toBe(1);
    }
  });

  test("a length header past the cap is a DISCONNECT, not an allocation", () => {
    for (const length of [CAP + 1, 262_144, 0x7fffffff, 0xffffffff]) {
      const h = harness();
      h.transport.receive(concat(VERSION, new Uint8Array([length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255])));
      expect(h.closed.length).toBe(1);
      expect(h.wroteDisconnect()).toBe(true);
    }
  });
});
