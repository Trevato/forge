/**
 * The SSH transport listens on a public port and promises to never throw at
 * its caller. These tests drive it directly with plaintext packets sent out of
 * order: each is refused with a DISCONNECT and a closed socket, and the
 * server's host-key signature (KEX_ECDH_REPLY) never goes out for them.
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createLog } from "../src/kernel/log.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostKey, loadOrCreateHostKey } from "../src/ssh/keys.ts";
import { Transport } from "../src/ssh/transport.ts";
import {
  concat,
  DISCONNECT,
  MSG,
  Reader,
  utf8,
  Writer,
} from "../src/ssh/wire.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

interface Sent {
  type: number;
  payload: Uint8Array;
}

function harness() {
  const hostKey: HostKey = loadOrCreateHostKey(
    mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kex-order-")),
  );
  const out: Uint8Array[] = [];
  const closed: string[] = [];
  const upper: Uint8Array[] = [];
  const transport = new Transport(
    {
      write: (data) => out.push(data.slice()),
      payload: (p) => upper.push(p),
      closed: (why) => closed.push(why),
      log: createLog("ssh-kex-order"),
    },
    { hostKey, serverVersion: "SSH-2.0-forge-test" },
  );
  transport.start();
  const send = (...payloads: Uint8Array[]) => {
    for (const p of payloads) transport.receive(plainPacket(p));
  };
  /** Plaintext packets the server wrote, in order, after its version line. */
  const sent = (): Sent[] => {
    const bytes = concat(...out);
    let at = bytes.indexOf(0x0a) + 1;
    const packets: Sent[] = [];
    while (at + 5 <= bytes.length) {
      const len = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
      const pad = bytes[at + 4]!;
      const payload = bytes.subarray(at + 5, at + 4 + len - pad);
      if (payload.length === 0) break;
      packets.push({ type: payload[0]!, payload });
      at += 4 + len;
    }
    return packets;
  };
  const disconnects = () =>
    sent()
      .filter((p) => p.type === MSG.DISCONNECT)
      .map((p) => {
        const r = new Reader(p.payload);
        r.u8();
        return { reason: r.u32(), text: new TextDecoder().decode(r.string()) };
      });
  const replies = () => sent().filter((p) => p.type === MSG.KEX_ECDH_REPLY);
  const feed = (bytes: Uint8Array) => transport.receive(bytes);
  return { feed, send, closed, upper, disconnects, replies, sent };
}

function plainPacket(payload: Uint8Array): Uint8Array {
  let pad = 8 - ((payload.length + 5) % 8);
  if (pad < 4) pad += 8;
  const w = new Writer(payload.length + pad + 8);
  return w
    .u32(payload.length + pad + 1)
    .u8(pad)
    .raw(payload)
    .raw(new Uint8Array(pad))
    .build();
}

const VERSION = utf8("SSH-2.0-client\r\n");

function clientKexInit(): Uint8Array {
  return new Writer(512)
    .u8(MSG.KEXINIT)
    .raw(randomBytes(16))
    .nameList(["curve25519-sha256", "kex-strict-c-v00@openssh.com"])
    .nameList(["ssh-ed25519"])
    .nameList(["aes256-gcm@openssh.com"])
    .nameList(["aes256-gcm@openssh.com"])
    .nameList(["hmac-sha2-256"])
    .nameList(["hmac-sha2-256"])
    .nameList(["none"])
    .nameList(["none"])
    .nameList([])
    .nameList([])
    .bool(false)
    .u32(0)
    .build();
}

function ecdhInit(): Uint8Array {
  const { publicKey } = generateKeyPairSync("x25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return new Writer(64).u8(MSG.KEX_ECDH_INIT).string(der.subarray(-32)).build();
}

const newKeys = () => new Uint8Array([MSG.NEWKEYS]);

function expectRefused(
  h: ReturnType<typeof harness>,
  text: string,
  reason: number = DISCONNECT.PROTOCOL_ERROR,
) {
  expect(h.closed).toEqual([text]);
  expect(h.disconnects()).toEqual([{ reason, text }]);
  expect(h.replies()).toHaveLength(0);
  expect(h.upper).toHaveLength(0);
}

describe("SSH key-exchange order", () => {
  function start() {
    const h = harness();
    return {
      h,
      go(...payloads: Uint8Array[]) {
        h.feed(VERSION);
        h.send(...payloads);
      },
    };
  }

  test("anything but KEXINIT first is refused", () => {
    const { h, go } = start();
    go(ecdhInit());
    expectRefused(h, "expected KEXINIT first");
  });

  test("a service request before KEXINIT is refused the same way", () => {
    const { h, go } = start();
    go(new Writer(32).u8(MSG.SERVICE_REQUEST).string("ssh-userauth").build());
    expectRefused(h, "expected KEXINIT first");
  });

  test("NEWKEYS first is refused", () => {
    const { h, go } = start();
    go(newKeys());
    expectRefused(h, "expected KEXINIT first");
  });

  test("a second KEXINIT is refused", () => {
    const { h, go } = start();
    go(clientKexInit(), clientKexInit());
    expectRefused(h, "duplicate KEXINIT");
  });

  test("NEWKEYS outside a key exchange is refused", () => {
    const { h, go } = start();
    go(clientKexInit(), newKeys());
    expectRefused(h, "NEWKEYS outside key exchange");
  });

  test("a second KEX_ECDH_INIT ends the connection after one reply", () => {
    const { h, go } = start();
    go(clientKexInit(), ecdhInit(), ecdhInit());
    expect(h.closed).toEqual(["duplicate KEX_ECDH_INIT"]);
    expect(h.replies()).toHaveLength(1);
    expect(h.upper).toHaveLength(0);
  });

  test("input after a refusal is ignored, not thrown", () => {
    const { h, go } = start();
    go(newKeys());
    expect(() => h.send(clientKexInit(), ecdhInit())).not.toThrow();
    expect(h.closed).toHaveLength(1);
    expect(h.replies()).toHaveLength(0);
  });
});
