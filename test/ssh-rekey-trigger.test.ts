/**
 * The server starts a rekey itself: after `rekeyBytes` of traffic or
 * `rekeyMs` under one set of keys, and not before. The transport is driven
 * directly, past its first exchange, with a clock the test holds.
 */

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../src/kernel/log.ts";
import { loadOrCreateHostKey } from "../src/ssh/keys.ts";
import { REKEY_BYTES, REKEY_MS, Transport } from "../src/ssh/transport.ts";
import { concat, MSG } from "../src/ssh/wire.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const hostKey = loadOrCreateHostKey(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ssh-rekey-")));

function established(options: { rekeyBytes?: number; rekeyMs?: number }) {
  let now = 1_000_000;
  const out: Uint8Array[] = [];
  const transport = new Transport(
    { write: (d) => out.push(d.slice()), payload: () => {}, closed: () => {}, log: createLog("ssh-rekey") },
    { hostKey, serverVersion: "SSH-2.0-forge", ...options, now: () => now },
  );
  transport.start();
  // Stand in for a finished first exchange (the interop suite does a real one).
  const inner = transport as unknown as { initialKexDone: boolean; kexActive: boolean; keyedAt: number; volume: number };
  inner.kexActive = false;
  inner.initialKexDone = true;
  inner.keyedAt = now;
  inner.volume = 0;
  out.length = 0;
  const kexinits = (): number => {
    const all = concat(...out);
    let n = 0;
    for (let at = 0; at + 6 <= all.length; ) {
      const len = new DataView(all.buffer, all.byteOffset + at).getUint32(0);
      if (all[at + 5] === MSG.KEXINIT) n++;
      at += 4 + len;
    }
    return n;
  };
  return { transport, kexinits, advance: (ms: number) => void (now += ms), inner };
}

test("the defaults are 1 GiB and an hour", () => {
  expect(REKEY_BYTES).toBe(1024 ** 3);
  expect(REKEY_MS).toBe(3_600_000);
});

test("no rekey while under both limits", () => {
  const t = established({ rekeyBytes: 10_000, rekeyMs: 60_000 });
  t.transport.send(new Uint8Array([MSG.IGNORE, 0, 0, 0, 0]));
  t.advance(59_000);
  t.transport.send(new Uint8Array([MSG.IGNORE, 0, 0, 0, 0]));
  expect(t.kexinits()).toBe(0);
});

test("an hour under one set of keys starts a rekey", () => {
  const t = established({ rekeyBytes: 10_000, rekeyMs: 60_000 });
  t.advance(60_000);
  t.transport.send(new Uint8Array([MSG.IGNORE, 0, 0, 0, 0]));
  expect(t.kexinits()).toBe(1);
  // Traffic during the exchange is parked, not another KEXINIT.
  t.transport.send(new Uint8Array([MSG.IGNORE, 0, 0, 0, 0]));
  expect(t.kexinits()).toBe(1);
});

test("the byte limit starts a rekey", () => {
  const t = established({ rekeyBytes: 10_000, rekeyMs: 3_600_000 });
  t.inner.volume = 10_000;
  t.transport.send(new Uint8Array([MSG.IGNORE, 0, 0, 0, 0]));
  expect(t.kexinits()).toBe(1);
});
