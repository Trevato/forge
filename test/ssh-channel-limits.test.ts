/**
 * The caps that keep an authenticated SSH peer from growing the forge's
 * memory or wedging a channel: at most 8 channels, a max packet floor, 32 env
 * vars of at most 1,024 bytes, CHANNEL_DATA no larger than 32,768 bytes, and
 * a remote window that never passes 2^32-1. Driven through `Channels`
 * directly with hand-built payloads, no socket.
 */

import { describe, expect, test } from "bun:test";
import { createLog } from "../src/kernel/log.ts";
import { Channels, type SshSession } from "../src/ssh/channels.ts";
import {
  DISCONNECT,
  MSG,
  OPEN_FAILURE,
  Reader,
  WireError,
  Writer,
} from "../src/ssh/wire.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
const log = createLog("ssh-channel-limits-test");
const UINT32_MAX = 0xffffffff;

function harness() {
  const sent: Uint8Array[] = [];
  const disconnects: { reason: number; description: string }[] = [];
  const sessions: SshSession[] = [];
  const channels = new Channels({
    send: (payload) => sent.push(payload),
    unimplemented: () => {},
    disconnect: (reason, description) =>
      disconnects.push({ reason, description }),
    onSession: (session) => sessions.push(session),
    key: {
      algo: "ssh-ed25519",
      blob: new Uint8Array(),
      fingerprint: "",
      line: "",
    },
    username: "tester",
    remoteAddress: "127.0.0.1",
    log,
  });
  let seq = 0;
  return {
    sent,
    disconnects,
    sessions,
    /** Hand one payload over the way `src/ssh/server.ts` pumps it: a
     *  `WireError` is a PROTOCOL_ERROR disconnect, anything else escapes. */
    handle(payload: Uint8Array): void {
      try {
        channels.handle(payload, seq++);
      } catch (cause) {
        if (!(cause instanceof WireError)) throw cause;
        disconnects.push({
          reason: DISCONNECT.PROTOCOL_ERROR,
          description: cause.message,
        });
      }
    },
    last: () => sent[sent.length - 1]!,
  };
}

function open(peerId: number, maxPacket = 32768, window = 1 << 20) {
  return new Writer(64)
    .u8(MSG.CHANNEL_OPEN)
    .string("session")
    .u32(peerId)
    .u32(window)
    .u32(maxPacket)
    .build();
}

function request(
  channel: number,
  type: string,
  fields: Uint8Array = new Uint8Array(),
) {
  return new Writer(256 + fields.length)
    .u8(MSG.CHANNEL_REQUEST)
    .u32(channel)
    .string(type)
    .bool(false)
    .raw(fields)
    .build();
}

function env(channel: number, name: string, value: string) {
  return request(
    channel,
    "env",
    new Writer(64 + value.length).string(name).string(value).build(),
  );
}

function data(channel: number, bytes: number) {
  return new Writer(bytes + 16)
    .u8(MSG.CHANNEL_DATA)
    .u32(channel)
    .string(new Uint8Array(bytes))
    .build();
}

function adjust(channel: number, bytes: number) {
  return new Writer(16)
    .u8(MSG.CHANNEL_WINDOW_ADJUST)
    .u32(channel)
    .u32(bytes)
    .build();
}

/** The reason code of a CHANNEL_OPEN_FAILURE, or undefined for anything else. */
function openFailure(
  payload: Uint8Array,
): { peerId: number; reason: number } | undefined {
  const r = new Reader(payload);
  if (r.u8() !== MSG.CHANNEL_OPEN_FAILURE) return undefined;
  return { peerId: r.u32(), reason: r.u32() };
}

describe("ssh channel limits", () => {
  test("a 9th channel is refused with RESOURCE_SHORTAGE until one closes", () => {
    const h = harness();
    for (let peer = 100; peer < 108; peer++) {
      h.handle(open(peer));
      expect(h.last()[0]).toBe(MSG.CHANNEL_OPEN_CONFIRMATION);
    }

    h.handle(open(108));
    expect(openFailure(h.last())).toEqual({
      peerId: 108,
      reason: OPEN_FAILURE.RESOURCE_SHORTAGE,
    });

    // Our ids run 1..8; closing one frees a slot.
    h.handle(new Writer(8).u8(MSG.CHANNEL_CLOSE).u32(3).build());
    h.handle(open(109));
    expect(h.last()[0]).toBe(MSG.CHANNEL_OPEN_CONFIRMATION);
    h.handle(open(110));
    expect(openFailure(h.last())?.reason).toBe(OPEN_FAILURE.RESOURCE_SHORTAGE);
    expect(h.disconnects).toEqual([]);
  });

  test("a max packet below the floor is ADMINISTRATIVELY_PROHIBITED", () => {
    const h = harness();
    h.handle(open(1, 127));
    expect(openFailure(h.last())).toEqual({
      peerId: 1,
      reason: OPEN_FAILURE.ADMINISTRATIVELY_PROHIBITED,
    });
    h.handle(open(2, 128));
    expect(h.last()[0]).toBe(MSG.CHANNEL_OPEN_CONFIRMATION);
    expect(h.disconnects).toEqual([]);
  });

  test("env keeps at most 32 variables, none longer than 1,024 bytes", () => {
    const h = harness();
    h.handle(open(1));
    h.handle(env(1, "BIG", "x".repeat(2000)));
    h.handle(env(1, "EDGE", "y".repeat(1024)));
    for (let i = 0; i < 40; i++) h.handle(env(1, `VAR_${i}`, String(i)));
    h.handle(request(1, "shell"));

    const session = h.sessions[0]!;
    expect(Object.keys(session.env)).toHaveLength(32);
    expect(session.env.BIG).toBeUndefined();
    expect(session.env.EDGE).toBe("y".repeat(1024));
    expect(session.env.VAR_30).toBe("30");
    expect(session.env.VAR_31).toBeUndefined();
    expect(h.disconnects).toEqual([]);
  });

  test("CHANNEL_DATA past 32,768 bytes disconnects and is never delivered", () => {
    const h = harness();
    h.handle(open(1));
    h.handle(request(1, "shell"));
    const received: number[] = [];
    h.sessions[0]!.onData((bytes) => received.push(bytes.length));

    h.handle(data(1, 32768));
    expect(h.disconnects).toEqual([]);
    expect(() => h.handle(data(1, 32769))).not.toThrow();
    expect(h.disconnects).toEqual([
      {
        reason: DISCONNECT.PROTOCOL_ERROR,
        description: "channel data exceeds maximum packet size",
      },
    ]);
    expect(received).toEqual([32768]);
  });

  test("a WINDOW_ADJUST past 2^32-1 disconnects", () => {
    const h = harness();
    h.handle(open(1, 32768, 1 << 20));
    h.handle(adjust(1, UINT32_MAX - (1 << 20)));
    expect(h.disconnects).toEqual([]);
    expect(() => h.handle(adjust(1, 1))).not.toThrow();
    expect(h.disconnects).toEqual([
      {
        reason: DISCONNECT.PROTOCOL_ERROR,
        description: "window adjust overflow",
      },
    ]);
  });
});
