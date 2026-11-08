/**
 * SSH auth refusals (#7203): every way an unauthenticated peer can misbehave
 * in `ssh-userauth` ends closed. An unknown service or channel traffic before
 * success disconnects; a non-publickey method, an unaccepted algorithm and a
 * blob that does not match its named algorithm each get FAILURE — and none of
 * them ever reaches `authorize` or `succeeded`.
 */
import { describe, expect, test } from "bun:test";
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { Auth, type AuthHost } from "../src/ssh/auth.ts";
import type { SshPublicKey } from "../src/ssh/keys.ts";
import { DISCONNECT, MSG, Reader, sshString, Writer } from "../src/ssh/wire.ts";

const sessionId = new Uint8Array(32).fill(7);

function jwkBytes(key: KeyObject, field: string): Uint8Array {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as Record<
    string,
    string
  >;
  return Buffer.from(jwk[field]!, "base64url");
}

const ed = generateKeyPairSync("ed25519").privateKey;
const edBlob = new Writer()
  .string("ssh-ed25519")
  .string(jwkBytes(ed, "x"))
  .build();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const rsaBlob = new Writer()
  .string("ssh-rsa")
  .mpint(jwkBytes(rsa, "e"))
  .mpint(jwkBytes(rsa, "n"))
  .build();

interface Fake {
  host: AuthHost;
  sent: Uint8Array[];
  disconnects: { reason: number; description: string }[];
  unimplemented: number[];
  authorized: { key: SshPublicKey; username: string }[];
  succeeded: { key: SshPublicKey; username: string }[];
}

/** A host that records everything and would authorize any key it is shown. */
function fakeHost(): Fake {
  const fake: Fake = {
    sent: [],
    disconnects: [],
    unimplemented: [],
    authorized: [],
    succeeded: [],
    host: undefined as unknown as AuthHost,
  };
  const quiet = () => {};
  fake.host = {
    send: (payload) => fake.sent.push(payload.slice()),
    unimplemented: (seq) => fake.unimplemented.push(seq),
    disconnect: (reason, description) =>
      fake.disconnects.push({ reason, description }),
    sessionId: () => sessionId,
    authorize: (key, username) => {
      fake.authorized.push({ key, username });
      return true;
    },
    succeeded: (key, username) => fake.succeeded.push({ key, username }),
    banner: undefined,
    maxAttempts: undefined,
    log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
  };
  return fake;
}

function serviceRequest(service: string): Uint8Array {
  return new Writer().u8(MSG.SERVICE_REQUEST).string(service).build();
}

function methodRequest(service: string, method: string): Uint8Array {
  return new Writer()
    .u8(MSG.USERAUTH_REQUEST)
    .string("alice")
    .string(service)
    .string(method)
    .build();
}

/** A publickey request; with `signWith`, a signature over RFC 4252 §7's blob. */
function publickeyRequest(
  algo: string,
  blob: Uint8Array,
  signWith?: (message: Uint8Array) => Uint8Array,
): Uint8Array {
  const prefix = new Writer()
    .u8(MSG.USERAUTH_REQUEST)
    .string("alice")
    .string("ssh-connection")
    .string("publickey")
    .bool(signWith !== undefined)
    .string(algo)
    .string(blob)
    .build();
  if (!signWith) return prefix;
  const message = new Writer()
    .raw(sshString(sessionId))
    .raw(prefix)
    .build();
  return new Writer().raw(prefix).string(signWith(message)).build();
}

/** The exact FAILURE payload: methods `publickey`, partial success false. */
const FAILURE = new Writer()
  .u8(MSG.USERAUTH_FAILURE)
  .nameList(["publickey"])
  .bool(false)
  .build();

function expectNeverAuthenticated(fake: Fake, auth: Auth): void {
  expect(fake.authorized).toEqual([]);
  expect(fake.succeeded).toEqual([]);
  expect(auth.authenticated).toBe(false);
  expect(fake.sent.some((p) => p[0] === MSG.USERAUTH_SUCCESS)).toBe(false);
}

describe("ssh auth: services", () => {
  test("SERVICE_ACCEPT echoes ssh-userauth byte for byte (RFC 4253 §10)", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    await auth.handle(serviceRequest("ssh-userauth"), 3);
    // byte SSH_MSG_SERVICE_ACCEPT (6), uint32 length 12, "ssh-userauth".
    expect([...fake.sent[0]!]).toEqual([
      6, 0, 0, 0, 12, ...new TextEncoder().encode("ssh-userauth"),
    ]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.disconnects).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });

  test("a SERVICE_REQUEST for ssh-agent disconnects", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    await auth.handle(serviceRequest("ssh-agent"), 3);
    expect(fake.disconnects).toEqual([
      {
        reason: DISCONNECT.SERVICE_NOT_AVAILABLE,
        description: "no service ssh-agent",
      },
    ]);
    expect(fake.sent).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });

  test("a USERAUTH_REQUEST for service ssh-foo disconnects", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    const payload = new Writer()
      .u8(MSG.USERAUTH_REQUEST)
      .string("alice")
      .string("ssh-foo")
      .string("publickey")
      .bool(false)
      .string("ssh-ed25519")
      .string(edBlob)
      .build();
    await auth.handle(payload, 4);
    expect(fake.disconnects).toEqual([
      {
        reason: DISCONNECT.SERVICE_NOT_AVAILABLE,
        description: "no service ssh-foo",
      },
    ]);
    expect(fake.sent).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });
});

describe("ssh auth: traffic before success", () => {
  const cases: [string, Uint8Array][] = [
    [
      "GLOBAL_REQUEST",
      new Writer()
        .u8(MSG.GLOBAL_REQUEST)
        .string("tcpip-forward")
        .bool(true)
        .string("0.0.0.0")
        .u32(22)
        .build(),
    ],
    [
      "CHANNEL_OPEN",
      new Writer()
        .u8(MSG.CHANNEL_OPEN)
        .string("session")
        .u32(0)
        .u32(1 << 20)
        .u32(1 << 15)
        .build(),
    ],
  ];
  for (const [name, payload] of cases) {
    test(`${name} before USERAUTH_SUCCESS disconnects`, async () => {
      const fake = fakeHost();
      const auth = new Auth(fake.host);
      await auth.handle(payload, 5);
      expect(fake.disconnects).toEqual([
        {
          reason: DISCONNECT.PROTOCOL_ERROR,
          description: `message ${payload[0]} before authentication`,
        },
      ]);
      expect(fake.unimplemented).toEqual([]);
      expect(fake.sent).toEqual([]);
      expectNeverAuthenticated(fake, auth);
    });
  }
});

describe("ssh auth: FAILURE", () => {
  for (const method of ["password", "none"]) {
    test(`method ${method} gets FAILURE listing only publickey`, async () => {
      const fake = fakeHost();
      const auth = new Auth(fake.host);
      await auth.handle(methodRequest("ssh-connection", method), 4);
      expect(fake.sent).toEqual([FAILURE]);
      const r = new Reader(fake.sent[0]!);
      expect(r.u8()).toBe(MSG.USERAUTH_FAILURE);
      expect(r.nameList()).toEqual(["publickey"]);
      expect(r.bool()).toBe(false);
      expect(fake.disconnects).toEqual([]);
      expectNeverAuthenticated(fake, auth);
    });
  }

  // `ssh-rsa` (SHA-1) is left out of ACCEPTED_KEY_ALGOS on purpose. The RSA
  // blob parses and its inner name matches, so only the allow-list stands
  // between this request and `authorize`.
  test("algorithm ssh-rsa with a valid RSA blob gets FAILURE (probe)", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    await auth.handle(publickeyRequest("ssh-rsa", rsaBlob), 4);
    expect(fake.sent).toEqual([FAILURE]);
    expect(fake.disconnects).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });

  test("algorithm ssh-rsa signed with SHA-1 gets FAILURE", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    const payload = publickeyRequest("ssh-rsa", rsaBlob, (message) =>
      new Writer()
        .string("ssh-rsa")
        .string(sign("sha1", message, rsa))
        .build(),
    );
    await auth.handle(payload, 4);
    expect(fake.sent).toEqual([FAILURE]);
    expect(fake.disconnects).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });

  // A DSS blob is refused by the parser before the allow-list matters, so
  // this pins that an unparseable blob fails closed, not the allow-list.
  test("an unparseable ssh-dss blob gets FAILURE", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    const dssBlob = new Writer()
      .string("ssh-dss")
      .mpint(new Uint8Array([1]))
      .mpint(new Uint8Array([2]))
      .mpint(new Uint8Array([3]))
      .mpint(new Uint8Array([4]))
      .build();
    await auth.handle(publickeyRequest("ssh-dss", dssBlob), 4);
    expect(fake.sent).toEqual([FAILURE]);
    expect(fake.disconnects).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });

  test("an ssh-ed25519 request carrying an RSA blob gets FAILURE", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    await auth.handle(publickeyRequest("ssh-ed25519", rsaBlob), 4);
    expect(fake.sent).toEqual([FAILURE]);
    expect(fake.disconnects).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });

  test("the same mismatch with a valid RSA signature still gets FAILURE", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    const payload = publickeyRequest("ssh-ed25519", rsaBlob, (message) =>
      new Writer()
        .string("rsa-sha2-256")
        .string(sign("sha256", message, rsa))
        .build(),
    );
    await auth.handle(payload, 4);
    expect(fake.sent).toEqual([FAILURE]);
    expect(fake.disconnects).toEqual([]);
    expectNeverAuthenticated(fake, auth);
  });
});

describe("ssh auth: the fake host is not vacuous", () => {
  // The refusals above prove nothing if the fake could never authorize, so
  // the well-formed requests must reach `authorize`, PK_OK and success.
  test("a matching ed25519 probe reaches authorize and gets PK_OK", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    await auth.handle(publickeyRequest("ssh-ed25519", edBlob), 4);
    expect(fake.authorized).toHaveLength(1);
    expect(fake.sent[0]![0]).toBe(MSG.USERAUTH_PK_OK);
    expect(auth.authenticated).toBe(false);
  });

  test("a matching signed ed25519 request succeeds", async () => {
    const fake = fakeHost();
    const auth = new Auth(fake.host);
    const payload = publickeyRequest("ssh-ed25519", edBlob, (message) =>
      new Writer()
        .string("ssh-ed25519")
        .string(sign(null, message, ed))
        .build(),
    );
    await auth.handle(payload, 4);
    expect(fake.succeeded).toHaveLength(1);
    expect(auth.authenticated).toBe(true);
    expect(fake.sent).toEqual([new Uint8Array([MSG.USERAUTH_SUCCESS])]);
  });
});
