/**
 * The SSH transport's framing refusals, over a real loopback listener: a bad
 * packet length or bad padding is a DISCONNECT(PROTOCOL_ERROR), the socket
 * closes, nothing throws into the listener, and the next connection is served.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../src/kernel/log.ts";
import { serveSsh, type SshServer } from "../src/ssh/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PROTOCOL_ERROR = 2;
const MSG_DISCONNECT = 1;
const MSG_KEXINIT = 20;
/** RFC 4253 §6.1: implementations must handle 35000 bytes of packet. */
const MAX_PLAINTEXT = 35000;

let root = "";
let server: SshServer;
const faults: unknown[] = [];
const onFault = (e: unknown) => void faults.push(e);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-ssh-framing-"));
  process.on("uncaughtException", onFault);
  server = await serveSsh({
    port: 0,
    hostname: "127.0.0.1",
    hostKeyDir: root,
    log: createLog("ssh-framing-test"),
    authorize: () => true,
    onSession: () => {},
    // Many short connections from loopback: this file is not about the limits.
    limits: { handshakesPerAddress: 10_000, handshakes: 10_000 },
  });
});

afterAll(() => {
  process.off("uncaughtException", onFault);
  expect(faults).toEqual([]);
  void server.stop();
  rmSync(root, { recursive: true, force: true });
});

const VERSION = new TextEncoder().encode("SSH-2.0-framing-test\r\n");

function frame(length: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, length);
  out.set(body, 4);
  return out;
}

function cat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Send `frames`, collect everything until the server closes. */
function talk(frames: readonly Uint8Array[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let got: Uint8Array = new Uint8Array(0);
    const timer = setTimeout(
      () => reject(new Error("server never closed the connection")),
      5000,
    );
    const done = () => {
      clearTimeout(timer);
      resolve(got);
    };
    void Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open(socket) {
          for (const f of frames) socket.write(f);
        },
        data(_s, chunk) {
          got = cat(got, new Uint8Array(chunk));
        },
        close: done,
        error: done,
      },
    }).catch(reject);
  });
}

interface Packet {
  type: number;
  payload: Uint8Array;
}

/** Split the server's plaintext output into its version line and packets. */
function parse(bytes: Uint8Array): { version: string; packets: Packet[] } {
  const nl = bytes.indexOf(0x0a);
  const version = new TextDecoder().decode(bytes.subarray(0, nl)).trim();
  const packets: Packet[] = [];
  let at = nl + 1;
  while (at + 5 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    const length = view.getUint32(0);
    const padding = bytes[at + 4]!;
    if (at + 4 + length > bytes.length) break;
    const payload = bytes.subarray(at + 5, at + 4 + length - padding);
    packets.push({ type: payload[0]!, payload });
    at += 4 + length;
  }
  return { version, packets };
}

function disconnectOf(bytes: Uint8Array): { reason: number; text: string } {
  const last = parse(bytes).packets.at(-1);
  expect(last?.type).toBe(MSG_DISCONNECT);
  const view = new DataView(
    last!.payload.buffer,
    last!.payload.byteOffset,
    last!.payload.length,
  );
  const n = view.getUint32(5);
  return {
    reason: view.getUint32(1),
    text: new TextDecoder().decode(last!.payload.subarray(9, 9 + n)),
  };
}

async function servedNormally(): Promise<void> {
  // A well-formed client: version line, then silence until we hang up.
  const got = await new Promise<Uint8Array>((resolve, reject) => {
    let data: Uint8Array = new Uint8Array(0);
    void Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open(s) {
          s.write(VERSION);
        },
        data(s, chunk) {
          data = cat(data, new Uint8Array(chunk));
          if (parse(data).packets.some((p) => p.type === MSG_KEXINIT)) {
            s.end();
            resolve(data);
          }
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
  const { version, packets } = parse(got);
  expect(version).toStartWith("SSH-2.0-");
  expect(packets[0]?.type).toBe(MSG_KEXINIT);
}

test("a zero packet length is a PROTOCOL_ERROR disconnect and a closed socket", async () => {
  const got = await talk([cat(VERSION, frame(0, new Uint8Array(0)))]);
  expect(disconnectOf(got)).toEqual({
    reason: PROTOCOL_ERROR,
    text: "bad packet length",
  });
  await servedNormally();
});

const BAD_LENGTH = { reason: PROTOCOL_ERROR, text: "bad packet length" };
const BAD_PADDING = { reason: PROTOCOL_ERROR, text: "bad padding length" };

// 4 + length is a multiple of 8 in each of these, so only the size is wrong;
// only the 4-byte header is sent, so the refusal must come from the length
// alone and never from buffering (or waiting for) that many bytes.
for (const length of [MAX_PLAINTEXT + 4, 0xfffffffc]) {
  test(`an aligned length of ${length} is over the limit and refused on the header`, async () => {
    expect((4 + length) % 8).toBe(0);
    const got = await talk([cat(VERSION, frame(length, new Uint8Array(0)))]);
    expect(disconnectOf(got)).toEqual(BAD_LENGTH);
    await servedNormally();
  });
}

test("the largest aligned length under the limit is not refused", async () => {
  // 34996 + 4 = 35000. Header only: the server must wait, not disconnect.
  const length = MAX_PLAINTEXT - 4;
  const got = await new Promise<Uint8Array>((resolve) => {
    let data: Uint8Array = new Uint8Array(0);
    void Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open(s) {
          s.write(cat(VERSION, frame(length, new Uint8Array(0))));
          setTimeout(() => {
            s.end();
            resolve(data);
          }, 200);
        },
        data(_s, chunk) {
          data = cat(data, new Uint8Array(chunk));
        },
      },
    });
  });
  expect(parse(got).packets.some((p) => p.type === MSG_DISCONNECT)).toBe(false);
});

// Misaligned lengths: refused by the alignment clause alone.
for (const length of [9, MAX_PLAINTEXT + 1, 0xffffffff]) {
  test(`a misaligned length of ${length} is refused`, async () => {
    expect((4 + length) % 8).not.toBe(0);
    const got = await talk([cat(VERSION, frame(length, new Uint8Array(0)))]);
    expect(disconnectOf(got)).toEqual(BAD_LENGTH);
    await servedNormally();
  });
}

// Aligned, in-range lengths with a padding byte the packet cannot hold.
const paddings: [string, number, number][] = [
  ["padding 3 (below the minimum of 4)", 12, 3],
  ["padding 0", 12, 0],
  ["padding 3 in a longer packet", 20, 3],
  ["padding == length - 1", 20, 19],
  ["padding == length", 12, 12],
  ["padding 250 in a small packet", 12, 250],
];
for (const [name, length, padding] of paddings) {
  test(`${name} is a PROTOCOL_ERROR disconnect`, async () => {
    expect((4 + length) % 8).toBe(0);
    const body = new Uint8Array(length);
    body[0] = padding;
    const got = await talk([cat(VERSION, frame(length, body))]);
    expect(disconnectOf(got)).toEqual(BAD_PADDING);
    await servedNormally();
  });
}
