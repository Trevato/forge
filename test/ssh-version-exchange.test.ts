/**
 * The SSH version exchange on a public port: bounded pre-banner junk, only
 * SSH-2.0, and a silent peer cut off by the login grace.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../src/kernel/log.ts";
import { loadOrCreateHostKey } from "../src/ssh/keys.ts";
import { serveSsh } from "../src/ssh/server.ts";
import { Transport } from "../src/ssh/transport.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
const log = createLog("ssh-version-test");
const enc = new TextEncoder();

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ssh-version-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness() {
  const written: Uint8Array[] = [];
  const closed: string[] = [];
  const payloads: number[] = [];
  const transport = new Transport(
    {
      write: (data) => void written.push(data.slice()),
      payload: (_p, seq) => void payloads.push(seq),
      closed: (why) => void closed.push(why),
      log,
    },
    { hostKey: loadOrCreateHostKey(root), serverVersion: "SSH-2.0-test" },
  );
  transport.start();
  return { transport, written, closed };
}

test("a few junk lines before a valid SSH-2.0 line are tolerated", () => {
  const { transport, closed } = harness();
  transport.receive(enc.encode("hello\r\nwelcome to nothing\n"));
  transport.receive(enc.encode("SSH-2.0-client\r\n"));
  expect(closed).toEqual([]);
});

test("junk past the limit ends the connection, having kept no more than the limit", () => {
  const { transport, closed } = harness();
  const line = enc.encode(`${"j".repeat(98)}\r\n`);
  let fed = 0;
  while (closed.length === 0 && fed < 100_000) {
    transport.receive(line);
    fed += line.length;
  }
  expect(closed).toEqual(["too much pre-version banner"]);
  // Stopped at the first line past 1024 bytes, not after streaming on.
  expect(fed).toBeLessThanOrEqual(1024 + line.length);
  // Anything after the cut is ignored.
  transport.receive(enc.encode("SSH-2.0-late\r\n"));
  expect(closed.length).toBe(1);
});

test("an endless line with no newline is refused at 255 bytes", () => {
  const { transport, closed } = harness();
  transport.receive(enc.encode("x".repeat(300)));
  expect(closed).toEqual(["version line too long"]);
});

test("a version line that is not SSH-2.0 is refused", () => {
  for (const line of ["SSH-1.5-x", "SSH-1.99-x", "SSH-2.1-x", "SSH-2.0"]) {
    const { transport, closed } = harness();
    transport.receive(enc.encode(`${line}\r\n`));
    expect(closed.length).toBe(1);
    expect(closed[0]).toContain("unsupported protocol version");
  }
});

test("a peer that sends nothing is closed by the login grace", async () => {
  const server = await serveSsh({
    port: 0,
    hostname: "127.0.0.1",
    hostKeyDir: mkdtempSync(join(root, "hostkey-")),
    log,
    loginGraceMs: 50,
    authorize: () => false,
    onSession: () => {},
  });
  try {
    let got = "";
    const ended = Promise.withResolvers<void>();
    await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        data: (_s, d) => void (got += Buffer.from(d).toString("latin1")),
        close: () => ended.resolve(),
        error: () => ended.resolve(),
      },
    });
    await Promise.race([
      ended.promise,
      Bun.sleep(3000).then(() => {
        throw new Error("silent peer was not closed");
      }),
    ]);
    expect(got.startsWith("SSH-2.0-forge\r\n")).toBe(true);
  } finally {
    server.stop();
  }
});
