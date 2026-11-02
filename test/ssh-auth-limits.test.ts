/**
 * The brute-force caps on the public SSH door: 6 signed attempts and 32
 * signature-less probes per connection. `Auth` is driven directly through a
 * fake host, so no socket and no OpenSSH are needed.
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createLog } from "../src/kernel/log.ts";
import { Auth, type AuthHost } from "../src/ssh/auth.ts";
import { DISCONNECT, MSG, sshString, Writer } from "../src/ssh/wire.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SESSION_ID = new Uint8Array(32).fill(7);

function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const blob = new Writer(64).string("ssh-ed25519").string(raw).build();
  return { privateKey, blob };
}

type Key = ReturnType<typeof newKey>;

/** USERAUTH_REQUEST for publickey; `signWith` makes a real signature, `true` a bad one. */
function request(key: Key, signed: false | true | "valid"): Uint8Array {
  const head = new Writer(256)
    .u8(MSG.USERAUTH_REQUEST)
    .string("tester")
    .string("ssh-connection")
    .string("publickey")
    .bool(signed !== false)
    .string("ssh-ed25519")
    .string(key.blob)
    .build();
  if (signed === false) return head;
  const message = new Writer(512)
    .raw(sshString(SESSION_ID))
    .raw(head)
    .build();
  const raw =
    signed === "valid"
      ? sign(null, message, key.privateKey)
      : new Uint8Array(64).fill(1);
  const sig = new Writer(128).string("ssh-ed25519").string(raw).build();
  return new Writer(512).raw(head).string(sig).build();
}

function harness(
  allowed: (key: Key) => boolean,
  keys: Key[],
  maxAttempts?: number,
) {
  const sent: Uint8Array[] = [];
  const disconnects: { reason: number; description: string }[] = [];
  const succeeded: string[] = [];
  const host: AuthHost = {
    send: (payload) => sent.push(payload),
    unimplemented: () => {},
    disconnect: (reason, description) => disconnects.push({ reason, description }),
    sessionId: () => SESSION_ID,
    authorize: (key) => {
      const match = keys.find((k) => Buffer.compare(k.blob, key.blob) === 0);
      return match !== undefined && allowed(match);
    },
    succeeded: (_key, username) => succeeded.push(username),
    banner: undefined,
    maxAttempts,
    log: createLog("ssh-auth-limits-test"),
  };
  return {
    auth: new Auth(host),
    types: () => sent.map((p) => p[0]),
    disconnects,
    succeeded,
  };
}

describe("ssh auth limits", () => {
  test("the 7th signed attempt disconnects and nothing is authorised", async () => {
    const key = newKey();
    const h = harness(() => true, [key]);
    for (let i = 0; i < 6; i++) await h.auth.handle(request(key, true), 1);
    expect(h.types()).toEqual(Array(6).fill(MSG.USERAUTH_FAILURE));
    expect(h.disconnects).toEqual([]);

    await h.auth.handle(request(key, true), 1);
    expect(h.disconnects).toEqual([
      {
        reason: DISCONNECT.NO_MORE_AUTH_METHODS_AVAILABLE,
        description: "too many authentication attempts",
      },
    ]);
    expect(h.types()).toHaveLength(6);
    expect(h.succeeded).toEqual([]);
    expect(h.auth.authenticated).toBe(false);
  });

  test("the 33rd unsigned probe disconnects", async () => {
    const key = newKey();
    const h = harness(() => false, [key]);
    for (let i = 0; i < 32; i++) await h.auth.handle(request(key, false), 1);
    expect(h.types()).toEqual(Array(32).fill(MSG.USERAUTH_FAILURE));
    expect(h.disconnects).toEqual([]);

    await h.auth.handle(request(key, false), 1);
    expect(h.disconnects).toHaveLength(1);
    expect(h.disconnects[0]!.reason).toBe(
      DISCONNECT.NO_MORE_AUTH_METHODS_AVAILABLE,
    );
    expect(h.types()).toHaveLength(32);
    expect(h.succeeded).toEqual([]);
    expect(h.auth.authenticated).toBe(false);
  });

  test("probes do not use up the signed-attempt budget", async () => {
    const key = newKey();
    const h = harness(() => true, [key]);
    for (let i = 0; i < 20; i++) await h.auth.handle(request(key, false), 1);
    await h.auth.handle(request(key, "valid"), 1);
    expect(h.disconnects).toEqual([]);
    expect(h.types().at(-1)).toBe(MSG.USERAUTH_SUCCESS);
    expect(h.succeeded).toEqual(["tester"]);
    expect(h.auth.authenticated).toBe(true);
  });

  test("host.maxAttempts overrides the default", async () => {
    const key = newKey();
    const h = harness(() => true, [key], 2);
    await h.auth.handle(request(key, true), 1);
    await h.auth.handle(request(key, true), 1);
    expect(h.disconnects).toEqual([]);
    await h.auth.handle(request(key, "valid"), 1);
    expect(h.disconnects).toHaveLength(1);
    expect(h.disconnects[0]!.description).toBe(
      "too many authentication attempts",
    );
    expect(h.succeeded).toEqual([]);

    const wide = harness(() => true, [key], 10);
    for (let i = 0; i < 10; i++) await wide.auth.handle(request(key, true), 1);
    expect(wide.disconnects).toEqual([]);
    await wide.auth.handle(request(key, true), 1);
    expect(wide.disconnects).toHaveLength(1);
  });
});
