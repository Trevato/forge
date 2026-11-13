/**
 * Interop tests for `src/ssh/`: every case drives the real OpenSSH client
 * binary. A hand-rolled client would only prove we agree with ourselves.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../src/kernel/log.ts";
import { quietLogs } from "./helpers/globals.ts";
import { Channels } from "../src/ssh/channels.ts";
import { MSG, WireError, Writer } from "../src/ssh/wire.ts";
import {
  serveSsh,
  type SshPublicKey,
  type SshServer,
  type SshServerOptions,
  type SshSession,
} from "../src/ssh/server.ts";
import { missing } from "./helpers/tools.ts";

const SSH = "/usr/bin/ssh";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
/** These drive the real OpenSSH client; without it they skip, loudly. */
const NO_OPENSSH = missing(SSH, SSH_KEYGEN);
const log = createLog("ssh-test");

let root = "";
const servers: SshServer[] = [];
const keys: Record<string, string> = {};

quietLogs();

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A deterministic-per-run payload big enough to exercise both windows. */
function payload(size: number): Uint8Array {
  const block = randomBytes(65536);
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += block.length) {
    out.set(block.subarray(0, Math.min(block.length, size - at)), at);
  }
  return out;
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

type Overrides = Partial<SshServerOptions> &
  Pick<SshServerOptions, "onSession">;

async function start(overrides: Overrides): Promise<SshServer> {
  const server = await serveSsh({
    port: 0,
    hostname: "127.0.0.1",
    hostKeyDir: mkdtempSync(join(root, "hostkey-")),
    log,
    authorize: () => true,
    ...overrides,
  });
  servers.push(server);
  return server;
}

interface SshRun {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  stdout: Promise<Uint8Array>;
  stderr: Promise<string>;
}

function ssh(
  port: number,
  key: string,
  flags: string[],
  command: string[],
  user = "user",
): SshRun {
  const proc = Bun.spawn(
    [
      SSH,
      "-p",
      String(port),
      "-i",
      key,
      ...flags,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=5",
      `${user}@127.0.0.1`,
      ...command,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  return {
    proc,
    stdout: new Response(proc.stdout)
      .arrayBuffer()
      .then((buffer) => new Uint8Array(buffer)),
    stderr: new Response(proc.stderr).text(),
  };
}

// --- a minimal client-side curve25519-sha256 key exchange, hand-rolled so a
// test can attack the space between KEX_ECDH_REPLY and NEWKEYS that the
// OpenSSH client can never be made to leave open. ------------------------

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}
function wireString(bytes: Uint8Array | string): Uint8Array {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return concat([u32(b.length), b]);
}
function wireNameList(names: string[]): Uint8Array {
  return wireString(names.join(","));
}
function wireMpint(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length && value[start] === 0) start++;
  const magnitude = value.subarray(start);
  if (magnitude.length === 0) return u32(0);
  const needsSignByte = (magnitude[0]! & 0x80) !== 0;
  const out = new Uint8Array(magnitude.length + (needsSignByte ? 1 : 0));
  out.set(magnitude, needsSignByte ? 1 : 0);
  return concat([u32(out.length), out]);
}
/** Frame a payload under the `none` cipher (RFC 4253 §6): what a peer sends
 *  before its own NEWKEYS. */
function framePlaintext(payloadBytes: Uint8Array): Uint8Array {
  let padding = (8 - ((5 + payloadBytes.length) % 8)) % 8;
  if (padding < 4) padding += 8;
  const packetLength = 1 + payloadBytes.length + padding;
  const frame = new Uint8Array(4 + packetLength);
  new DataView(frame.buffer).setUint32(0, packetLength, false);
  frame[4] = padding;
  frame.set(payloadBytes, 5);
  frame.set(randomBytes(padding), 5 + payloadBytes.length);
  return frame;
}

/** Buffers raw socket bytes and hands out version lines / plaintext packets
 *  as they complete, async-await style. */
class RawRecv {
  private buf = new Uint8Array(0);
  private waiters: (() => void)[] = [];
  push(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
    for (const w of this.waiters.splice(0)) w();
  }
  private async waitMore(): Promise<void> {
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  async readLine(): Promise<string> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        const end = nl > 0 && this.buf[nl - 1] === 0x0d ? nl - 1 : nl;
        const line = new TextDecoder().decode(this.buf.subarray(0, end));
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      await this.waitMore();
    }
  }
  async readPlainPacket(): Promise<Uint8Array> {
    for (;;) {
      if (this.buf.length >= 4) {
        const length = new DataView(
          this.buf.buffer,
          this.buf.byteOffset,
          4,
        ).getUint32(0, false);
        if (this.buf.length >= 4 + length) {
          const padding = this.buf[4]!;
          const payloadBytes = this.buf
            .subarray(5, 4 + length - padding)
            .slice();
          this.buf = this.buf.subarray(4 + length);
          return payloadBytes;
        }
      }
      await this.waitMore();
    }
  }
}

function readWireString(buf: Uint8Array, at: number): [Uint8Array, number] {
  const len = new DataView(buf.buffer, buf.byteOffset + at, 4).getUint32(
    0,
    false,
  );
  return [buf.subarray(at + 4, at + 4 + len), at + 4 + len];
}

/**
 * Connects, exchanges versions, sends a KEXINIT that omits
 * `kex-strict-c-v00@openssh.com` and `ext-info-c` entirely (a client under no
 * obligation to negotiate strict KEX), and drives KEX_ECDH_INIT/REPLY far
 * enough to know the real session id (H) — all without ever sending our own
 * NEWKEYS. Returns the socket, receiver, and H so a test can then try to
 * smuggle plaintext upper-layer traffic through before completing the kex.
 */
async function nonStrictKexUpToEcdhReply(port: number): Promise<{
  socket: Bun.Socket<undefined>;
  recv: RawRecv;
  sessionId: Uint8Array;
}> {
  const recv = new RawRecv();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        recv.push(chunk);
      },
      open() {},
      close() {},
      error() {},
    },
  });

  const clientVersion = "SSH-2.0-probe";
  socket.write(new TextEncoder().encode(`${clientVersion}\r\n`));
  const serverVersion = await recv.readLine();
  const serverKexInit = await recv.readPlainPacket();

  const myKexInit = concat([
    new Uint8Array([MSG.KEXINIT]),
    randomBytes(16),
    wireNameList(["curve25519-sha256"]),
    wireNameList(["ssh-ed25519"]),
    wireNameList(["aes256-gcm@openssh.com"]),
    wireNameList(["aes256-gcm@openssh.com"]),
    wireNameList(["hmac-sha2-256"]),
    wireNameList(["hmac-sha2-256"]),
    wireNameList(["none"]),
    wireNameList(["none"]),
    wireNameList([]),
    wireNameList([]),
    new Uint8Array([0]),
    u32(0),
  ]);
  socket.write(framePlaintext(myKexInit));

  const ephemeral = generateKeyPairSync("x25519");
  const spki = ephemeral.publicKey.export({ type: "spki", format: "der" });
  const clientPublic = new Uint8Array(spki.subarray(spki.length - 32));
  socket.write(
    framePlaintext(
      concat([new Uint8Array([MSG.KEX_ECDH_INIT]), wireString(clientPublic)]),
    ),
  );

  const ecdhReply = await recv.readPlainPacket();
  let at = 1;
  let hostBlob: Uint8Array;
  let serverPublic: Uint8Array;
  [hostBlob, at] = readWireString(ecdhReply, at);
  [serverPublic, at] = readWireString(ecdhReply, at);

  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: Buffer.from(serverPublic).toString("base64url"),
      },
      format: "jwk",
    }),
  });
  const kMpint = wireMpint(shared);
  const sessionId = new Uint8Array(
    createHash("sha256")
      .update(wireString(clientVersion))
      .update(wireString(serverVersion))
      .update(wireString(myKexInit))
      .update(wireString(serverKexInit))
      .update(wireString(hostBlob))
      .update(wireString(clientPublic))
      .update(wireString(serverPublic))
      .update(kMpint)
      .digest(),
  );

  return { socket, recv, sessionId };
}

/** Open a raw TCP connection, send `frames`, and resolve when it closes. */
function probe(
  port: number,
  frames: readonly Uint8Array[],
  timeoutMs = 8000,
): Promise<number> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server never closed the connection")),
      timeoutMs,
    );
    const finish = () => {
      clearTimeout(timer);
      resolve(Date.now() - started);
    };
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          for (const frame of frames) socket.write(frame);
        },
        data() {},
        close: finish,
        error: finish,
      },
    }).catch(reject);
  });
}

beforeAll(async () => {
  // This hook belongs to the file, not to a describe, so it runs even when
  // every case in it is skipped: with no ssh-keygen there are no keys to
  // make, and nothing that wanted them will run.
  if (NO_OPENSSH) return;
  root = mkdtempSync(join(tmpdir(), "forge-ssh-"));
  const specs: [string, string[]][] = [
    ["ed25519", ["-t", "ed25519"]],
    ["ecdsa", ["-t", "ecdsa", "-b", "256"]],
    ["rsa", ["-t", "rsa", "-b", "3072"]],
    ["other", ["-t", "ed25519"]],
  ];
  for (const [name, args] of specs) {
    const path = join(root, `id_${name}`);
    keys[name] = path;
    const proc = Bun.spawn(
      [SSH_KEYGEN, ...args, "-N", "", "-q", "-C", `${name}@test`, "-f", path],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);
  }
});

afterAll(() => {
  for (const server of servers) server.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(NO_OPENSSH)("ssh drain", () => {
  test("a draining server keeps who is connected, answers nobody new, and ends when the last leaves", async () => {
    const server = await start({ onSession: () => {} });
    const opened = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    // The connection is counted the moment it opens.
    const deadline = Date.now() + 2_000;
    while (server.sessions() === 0 && Date.now() < deadline)
      await Bun.sleep(10);
    expect(server.sessions()).toBe(1);

    let ended = false;
    const drained = server.drain().then(() => {
      ended = true;
    });
    await Bun.sleep(50);
    // Still here: the open connection is kept, and the drain waits on it.
    expect(server.sessions()).toBe(1);
    expect(ended).toBe(false);
    // Nobody new is answered.
    const refused = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    }).then(
      () => "connected",
      () => "refused",
    );
    expect(refused).toBe("refused");
    // The last one leaves, and the drain is done.
    opened.end();
    await drained;
    expect(ended).toBe(true);
    expect(server.sessions()).toBe(0);
  });
});

describe.skipIf(NO_OPENSSH)("ssh exec sessions", () => {
  test("runs a command, returns output and an exit status", async () => {
    let seen: SshSession | undefined;
    const server = await start({
      onSession(session) {
        seen = session;
        session.write(`hello ${session.username}\n`);
        session.exit(3);
      },
    });
    const client = ssh(server.port, keys.ed25519!, [], ["echo-me"]);
    const out = await client.stdout;
    const code = await client.proc.exited;
    expect(new TextDecoder().decode(out)).toBe("hello user\n");
    expect(code).toBe(3);
    expect(seen?.kind).toBe("exec");
    expect(seen?.command).toBe("echo-me");
    expect(seen?.term).toBeUndefined();
  });

  test("stderr reaches the client's stderr, not its stdout", async () => {
    const server = await start({
      onSession(session) {
        session.write("out");
        session.writeStderr("err");
        session.exit(0);
      },
    });
    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    const out = new TextDecoder().decode(await client.stdout);
    const errText = await client.stderr;
    expect(await client.proc.exited).toBe(0);
    expect(out).toBe("out");
    expect(errText).toContain("err");
  });

  test("onSession throwing exits the channel cleanly and does not kill the server", async () => {
    const server = await start({
      onSession() {
        throw new Error("boom from onSession");
      },
    });
    const bad = ssh(server.port, keys.ed25519!, [], ["x"]);
    expect(await bad.proc.exited).toBe(1);

    // The event loop, and this server, must still be alive for the next
    // connection.
    let seen = false;
    const server2 = await start({
      onSession(session) {
        seen = true;
        session.write("still alive");
        session.exit(0);
      },
    });
    const good = ssh(server2.port, keys.ed25519!, [], ["x"]);
    expect(new TextDecoder().decode(await good.stdout)).toBe("still alive");
    expect(await good.proc.exited).toBe(0);
    expect(seen).toBe(true);
  });

  test("onData throwing does not crash the connection or the server", async () => {
    let dataCalls = 0;
    const server = await start({
      onSession(session) {
        session.onData(() => {
          dataCalls++;
          throw new Error("boom from onData");
        });
        session.onEof(() => session.exit(0));
      },
    });
    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    client.proc.stdin.write("trigger\n");
    await client.proc.stdin.end();
    expect(await client.proc.exited).toBe(0);
    expect(dataCalls).toBeGreaterThan(0);

    // Server keeps serving after an onData throw.
    const server2 = await start({
      onSession(session) {
        session.write("ok");
        session.exit(0);
      },
    });
    const good = ssh(server2.port, keys.ed25519!, [], ["x"]);
    expect(new TextDecoder().decode(await good.stdout)).toBe("ok");
    expect(await good.proc.exited).toBe(0);
  });
});

describe.skipIf(NO_OPENSSH)("ssh shell sessions", () => {
  test("pty-req, echo, and EOF ending the session", async () => {
    let seen: SshSession | undefined;
    let ended = false;
    const server = await start({
      onSession(session) {
        seen = session;
        session.onData((data) => session.write(data));
        session.onEof(() => {
          ended = true;
          session.exit(0);
        });
      },
    });
    // -tt forces pty allocation even though our stdin is a pipe.
    const client = ssh(server.port, keys.ed25519!, ["-tt"], []);
    client.proc.stdin.write("ping\n");
    await client.proc.stdin.end();
    const out = new TextDecoder().decode(await client.stdout);
    expect(await client.proc.exited).toBe(0);
    expect(out).toContain("ping");
    expect(seen?.kind).toBe("shell");
    expect(seen?.command).toBeUndefined();
    expect(seen?.term).toBeTruthy();
    expect(ended).toBe(true);
  });

  test("EOF is not a close: the channel stays writable until the peer goes", async () => {
    const seen: string[] = [];
    let live: SshSession | undefined;
    const gone = Promise.withResolvers<void>();
    const server = await start({
      onSession(session) {
        live = session;
        session.onEof(() => {
          // Still writable: a clone's pack is sent entirely after this point.
          seen.push(`eof:${String(session.ended)}`);
          session.write("after-eof");
          session.exit(0);
        });
        session.onClose(() => {
          seen.push(`close:${String(session.ended)}`);
          gone.resolve();
        });
      },
    });
    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    await client.proc.stdin.end();
    const out = new TextDecoder().decode(await client.stdout);
    expect(await client.proc.exited).toBe(0);
    expect(out).toBe("after-eof");
    await gone.promise;
    // EOF first and with the channel still alive; close second, and only once.
    expect(seen).toEqual(["eof:false", "close:true"]);
    expect(live?.ended).toBe(true);
  });

  test("SetEnv variables arrive on the session", async () => {
    let seen: SshSession | undefined;
    const server = await start({
      onSession(session) {
        seen = session;
        session.exit(0);
      },
    });
    const client = ssh(
      server.port,
      keys.ed25519!,
      ["-o", "SetEnv=GIT_PROTOCOL=version=2"],
      ["x"],
    );
    expect(await client.proc.exited).toBe(0);
    expect(seen?.env.GIT_PROTOCOL).toBe("version=2");
  });
});

describe.skipIf(NO_OPENSSH)("ssh publickey authentication", () => {
  const cases: [string, string][] = [
    ["ed25519", "ssh-ed25519"],
    ["ecdsa", "ecdsa-sha2-nistp256"],
    // RSA only works because we send EXT_INFO server-sig-algs: without it the
    // client offers SHA-1 ssh-rsa, which we reject.
    ["rsa", "ssh-rsa"],
  ];
  for (const [name, algo] of cases) {
    test(`${name} keys authenticate and report the right identity`, async () => {
      let seen: SshPublicKey | undefined;
      const server = await start({
        authorize(key) {
          seen = key;
          return true;
        },
        onSession(session) {
          session.write(session.key.fingerprint);
          session.exit(0);
        },
      });
      const client = ssh(server.port, keys[name]!, [], ["x"]);
      const out = new TextDecoder().decode(await client.stdout);
      expect(await client.proc.exited).toBe(0);
      expect(seen?.algo).toBe(algo);

      // Cross-check against the tool operators actually use.
      const listed = await run([SSH_KEYGEN, "-lf", `${keys[name]}.pub`]);
      const printed = listed.split(/\s+/)[1];
      expect(seen?.fingerprint).toBe(printed!);
      expect(out).toBe(printed!);
      expect(seen?.line).toBe(
        readFileSync(`${keys[name]}.pub`, "utf8")
          .trim()
          .split(" ")
          .slice(0, 2)
          .join(" "),
      );
    });
  }

  test("a rejected key never reaches onSession", async () => {
    let sessions = 0;
    const server = await start({
      authorize: () => false,
      onSession() {
        sessions++;
      },
    });
    const client = ssh(server.port, keys.other!, [], ["x"]);
    expect(await client.proc.exited).toBe(255);
    expect(await client.stderr).toContain("Permission denied");
    expect(sessions).toBe(0);
  });

  test("an authorize() promise that rejects fails closed, not open, and keeps the server alive", async () => {
    let sessions = 0;
    const server = await start({
      authorize: () => Promise.reject(new Error("db unreachable")),
      onSession() {
        sessions++;
      },
    });
    const client = ssh(server.port, keys.other!, [], ["x"]);
    expect(await client.proc.exited).toBe(255);
    expect(await client.stderr).toContain("Permission denied");
    expect(sessions).toBe(0);

    // A rejected promise must not leave an unhandled rejection that kills
    // the process — prove the server still answers a normal client.
    const server2 = await start({ onSession: (s) => s.exit(0) });
    const good = ssh(server2.port, keys.ed25519!, [], ["x"]);
    expect(await good.proc.exited).toBe(0);
  });

  test("authorize sees the SSH username", async () => {
    const users: string[] = [];
    const server = await start({
      authorize(_key, username) {
        users.push(username);
        return true;
      },
      onSession(session) {
        session.write(session.username);
        session.exit(0);
      },
    });
    const client = ssh(server.port, keys.ed25519!, [], ["x"], "git");
    const out = new TextDecoder().decode(await client.stdout);
    expect(await client.proc.exited).toBe(0);
    expect(out).toBe("git");
    expect(new Set(users)).toEqual(new Set(["git"]));
  });

  test("only publickey is offered", async () => {
    const server = await start({ onSession: (s) => s.exit(0) });
    const client = ssh(
      server.port,
      keys.ed25519!,
      [
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "PreferredAuthentications=password",
      ],
      ["x"],
    );
    expect(await client.proc.exited).toBe(255);
    expect(await client.stderr).toContain("publickey");
  });
});

describe.skipIf(NO_OPENSSH)("ssh flow control", () => {
  const SIZE = 3 * 1024 * 1024;

  test("server writes 3 MiB past the peer window", async () => {
    const data = payload(SIZE);
    const server = await start({
      onSession(session) {
        session.write(data);
        session.exit(0);
      },
    });
    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    const out = await client.stdout;
    expect(await client.proc.exited).toBe(0);
    expect(out.length).toBe(SIZE);
    expect(sha256(out)).toBe(sha256(data));
  }, 30_000);

  test("client pipes 3 MiB in and we top the window up", async () => {
    const data = payload(SIZE);
    let resolve: (digest: string) => void = () => {};
    const received = new Promise<string>((r) => {
      resolve = r;
    });
    const server = await start({
      onSession(session) {
        const chunks: Uint8Array[] = [];
        session.onData((chunk) => chunks.push(chunk));
        session.onEof(() => {
          resolve(sha256(concat(chunks)));
          session.exit(0);
        });
      },
    });
    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    client.proc.stdin.write(data);
    await client.proc.stdin.end();
    expect(await client.proc.exited).toBe(0);
    expect(await received).toBe(sha256(data));
  }, 30_000);
});

describe.skipIf(NO_OPENSSH)("ssh rekey", () => {
  test("survives client-initiated rekey with RekeyLimit=64K", async () => {
    const size = 1024 * 1024;
    const down = payload(size);
    const up = payload(size);
    let resolve: (digest: string) => void = () => {};
    const received = new Promise<string>((r) => {
      resolve = r;
    });
    const server = await start({
      onSession(session) {
        const chunks: Uint8Array[] = [];
        session.onData((chunk) => chunks.push(chunk));
        session.onEof(() => {
          resolve(sha256(concat(chunks)));
          session.exit(0);
        });
        session.write(down);
      },
    });
    const client = ssh(
      server.port,
      keys.ed25519!,
      ["-o", "RekeyLimit=64K"],
      ["x"],
    );
    client.proc.stdin.write(up);
    await client.proc.stdin.end();
    const out = await client.stdout;
    const code = await client.proc.exited;
    if (code !== 0) console.error(await client.stderr);
    expect(code).toBe(0);
    expect(sha256(out)).toBe(sha256(down));
    expect(await received).toBe(sha256(up));
  }, 60_000);
});

describe.skipIf(NO_OPENSSH)("ssh server-initiated rekey", () => {
  test("the server starts a rekey itself after rekeyBytes, and the session survives it", async () => {
    const down = payload(1024 * 1024);
    const server = await start({
      rekey: { rekeyBytes: 64 * 1024 },
      onSession(session) {
        session.onEof(() => session.exit(0));
        session.write(down);
      },
    });
    const client = ssh(server.port, keys.ed25519!, ["-v"], ["x"]);
    await client.proc.stdin.end();
    const out = await client.stdout;
    const err = await client.stderr;
    expect(await client.proc.exited).toBe(0);
    expect(sha256(out)).toBe(sha256(down));
    // The client logs each key exchange it takes part in: more than the first.
    expect(err.match(/SSH2_MSG_KEX_ECDH_REPLY received/g)?.length ?? 0).toBeGreaterThan(1);
  }, 60_000);
});

describe.skipIf(NO_OPENSSH)("ssh resilience", () => {
  test("garbage after the version line is disconnected, server keeps serving", async () => {
    const server = await start({
      onSession(session) {
        session.write("still here");
        session.exit(0);
      },
    });
    const junk = new Uint8Array(512).fill(0xff);
    await probe(server.port, [
      new TextEncoder().encode("SSH-2.0-junk\r\n"),
      junk,
    ]);

    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    const out = new TextDecoder().decode(await client.stdout);
    expect(await client.proc.exited).toBe(0);
    expect(out).toBe("still here");
  });

  test("a truncated version line closes without crashing", async () => {
    const server = await start({ onSession: (s) => s.exit(0) });
    await probe(server.port, [new Uint8Array(400).fill(0x41)]);
    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    expect(await client.proc.exited).toBe(0);
  });

  test("an unauthenticated connection is dropped after the grace period", async () => {
    const server = await start({
      loginGraceMs: 400,
      onSession: (s) => s.exit(0),
    });
    const elapsed = await probe(server.port, [
      new TextEncoder().encode("SSH-2.0-idle\r\n"),
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5000);
  }, 15_000);

  test("a client offering no shared cipher fails negotiation cleanly", async () => {
    const server = await start({ onSession: (s) => s.exit(0) });
    const client = ssh(
      server.port,
      keys.ed25519!,
      [
        "-o",
        "LogLevel=INFO",
        "-o",
        "Ciphers=aes128-ctr",
        "-o",
        "MACs=hmac-sha2-256",
      ],
      ["x"],
    );
    expect(await client.proc.exited).toBe(255);
    expect(await client.stderr).toContain("no matching cipher");
  });

  for (const cipher of ["aes128-gcm@openssh.com", "aes256-gcm@openssh.com"]) {
    test(`negotiates ${cipher}`, async () => {
      const server = await start({
        onSession(session) {
          session.write("ok");
          session.exit(0);
        },
      });
      const client = ssh(
        server.port,
        keys.ed25519!,
        ["-o", `Ciphers=${cipher}`],
        ["x"],
      );
      expect(new TextDecoder().decode(await client.stdout)).toBe("ok");
      expect(await client.proc.exited).toBe(0);
    });
  }
});

describe.skipIf(NO_OPENSSH)("ssh host key", () => {
  test("persists across restarts and matches ssh-keygen", async () => {
    const dir = mkdtempSync(join(root, "persist-"));
    const first = await start({ hostKeyDir: dir, onSession: (s) => s.exit(0) });
    const fingerprint = first.hostKey.fingerprint;
    first.stop();

    const second = await start({
      hostKeyDir: dir,
      onSession: (s) => s.exit(0),
    });
    expect(second.hostKey.fingerprint).toBe(fingerprint);

    const listed = await run([
      SSH_KEYGEN,
      "-lf",
      join(dir, "host_ed25519.pub"),
    ]);
    expect(listed.split(/\s+/)[1]).toBe(fingerprint);
    expect(fingerprint.startsWith("SHA256:")).toBe(true);
    expect(fingerprint).not.toContain("=");
  });
});

describe.skipIf(NO_OPENSSH)("ssh key exchange discipline", () => {
  test("a client that never sends NEWKEYS cannot smuggle USERAUTH_REQUEST through in plaintext", async () => {
    let authCalls = 0;
    let sessionCalls = 0;
    const server = await start({
      authorize() {
        authCalls++;
        return true;
      },
      onSession() {
        sessionCalls++;
      },
    });

    // Omit kex-strict-c-v00@openssh.com entirely: a raw client is under no
    // protocol obligation to advertise strict KEX, so the server must reject
    // non-KEX traffic before NEWKEYS on its own, not rely on strict KEX to
    // do it.
    const { socket } = await nonStrictKexUpToEcdhReply(server.port);

    // Instead of NEWKEYS, go straight for ssh-userauth in the clear.
    socket.write(
      framePlaintext(
        concat([
          new Uint8Array([MSG.SERVICE_REQUEST]),
          wireString("ssh-userauth"),
        ]),
      ),
    );
    const probeKey = generateKeyPairSync("ed25519");
    const jwk = probeKey.publicKey.export({ format: "jwk" }) as { x: string };
    const rawPub = new Uint8Array(Buffer.from(jwk.x, "base64url"));
    const keyBlob = concat([wireString("ssh-ed25519"), wireString(rawPub)]);
    socket.write(
      framePlaintext(
        concat([
          new Uint8Array([MSG.USERAUTH_REQUEST]),
          wireString("attacker"),
          wireString("ssh-connection"),
          wireString("publickey"),
          new Uint8Array([0]), // signature-less query is enough to prove the leak
          wireString("ssh-ed25519"),
          wireString(keyBlob),
        ]),
      ),
    );

    // The server must disconnect rather than answer or call into authorize().
    await Bun.sleep(500);
    expect(authCalls).toBe(0);
    expect(sessionCalls).toBe(0);
    socket.end();
  });
});

/**
 * The OpenSSH client reads the pty size from its own stdin, so a harness with
 * a piped stdin makes it send 0x0 and never send `window-change`. These drive
 * the connection layer directly with hand-built wire payloads so the
 * dimension, resize and rejection paths are still covered.
 */
describe.skipIf(NO_OPENSSH)("ssh channel layer", () => {
  function harness() {
    const sent: Uint8Array[] = [];
    let session: SshSession | undefined;
    const channels = new Channels({
      send: (payload) => sent.push(payload),
      unimplemented: () => {},
      disconnect: () => {},
      onSession: (value) => {
        session = value;
      },
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
    return {
      channels,
      sent,
      get session() {
        return session;
      },
      types: () => sent.map((payload) => payload[0]),
    };
  }

  function open(kind: string, peerId: number): Uint8Array {
    return new Writer(64)
      .u8(MSG.CHANNEL_OPEN)
      .string(kind)
      .u32(peerId)
      .u32(1 << 20)
      .u32(32768)
      .build();
  }

  function request(
    channel: number,
    type: string,
    fields: Uint8Array,
  ): Uint8Array {
    return new Writer(256)
      .u8(MSG.CHANNEL_REQUEST)
      .u32(channel)
      .string(type)
      .bool(true)
      .raw(fields)
      .build();
  }

  test("pty-req dimensions and window-change reach the session", () => {
    const h = harness();
    h.channels.handle(open("session", 7), 0);
    expect(h.types()).toEqual([MSG.CHANNEL_OPEN_CONFIRMATION]);

    h.channels.handle(
      request(
        1,
        "pty-req",
        new Writer(64)
          .string("xterm-256color")
          .u32(120)
          .u32(40)
          .u32(960)
          .u32(640)
          .string(new Uint8Array([53, 0, 0, 0, 1, 0]))
          .build(),
      ),
      1,
    );
    h.channels.handle(request(1, "shell", new Uint8Array()), 2);
    expect(h.session?.kind).toBe("shell");
    expect(h.session?.term).toBe("xterm-256color");
    expect(h.session?.cols).toBe(120);
    expect(h.session?.rows).toBe(40);
    // The pixel fields most clients send as zeros. When a client does report
    // them, they are how the TUI learns its cell geometry — 8×16 here — and
    // a picture drawn to the wrong aspect looks like a rendering fault.
    expect(h.session?.widthPx).toBe(960);
    expect(h.session?.heightPx).toBe(640);

    let resized: [number, number] | undefined;
    h.session?.onResize((cols, rows) => {
      resized = [cols, rows];
    });
    h.channels.handle(
      new Writer(64)
        .u8(MSG.CHANNEL_REQUEST)
        .u32(1)
        .string("window-change")
        .bool(false)
        .u32(100)
        .u32(30)
        .u32(800)
        .u32(480)
        .build(),
      3,
    );
    expect(resized).toEqual([100, 30]);
    // A resize moves the pixel size too, so the cell geometry follows it.
    expect(h.session?.widthPx).toBe(800);
    expect(h.session?.heightPx).toBe(480);
    // window-change carries want_reply FALSE: replying would desynchronise
    // the client's reply queue.
    expect(h.types()).toEqual([
      MSG.CHANNEL_OPEN_CONFIRMATION,
      MSG.CHANNEL_SUCCESS,
      MSG.CHANNEL_SUCCESS,
    ]);
  });

  test("rejects a second shell, subsystems, and foreign channel types", () => {
    const h = harness();
    h.channels.handle(open("direct-tcpip", 1), 0);
    expect(h.types()).toEqual([MSG.CHANNEL_OPEN_FAILURE]);

    h.channels.handle(open("session", 1), 1);
    h.channels.handle(request(1, "shell", new Uint8Array()), 2);
    h.channels.handle(
      request(1, "exec", new Writer(16).string("x").build()),
      3,
    );
    h.channels.handle(
      request(1, "subsystem", new Writer(16).string("sftp").build()),
      4,
    );
    expect(h.types().slice(1)).toEqual([
      MSG.CHANNEL_OPEN_CONFIRMATION,
      MSG.CHANNEL_SUCCESS,
      MSG.CHANNEL_FAILURE,
      MSG.CHANNEL_FAILURE,
    ]);
  });

  test("answers keepalive@openssh.com with REQUEST_FAILURE", () => {
    const h = harness();
    h.channels.handle(
      new Writer(64)
        .u8(MSG.GLOBAL_REQUEST)
        .string("keepalive@openssh.com")
        .bool(true)
        .build(),
      0,
    );
    h.channels.handle(
      new Writer(64)
        .u8(MSG.GLOBAL_REQUEST)
        .string("no-more-sessions@openssh.com")
        .bool(false)
        .build(),
      1,
    );
    expect(h.types()).toEqual([MSG.REQUEST_FAILURE]);
  });

  test("a peer that overruns the channel window is a protocol error", () => {
    const h = harness();
    h.channels.handle(open("session", 1), 0);
    const oversized = new Writer(40000)
      .u8(MSG.CHANNEL_DATA)
      .u32(1)
      .string(new Uint8Array(33000))
      .build();
    expect(() => h.channels.handle(oversized, 1)).toThrow(WireError);
  });
});

describe.skipIf(NO_OPENSSH)("ssh fuzzing", () => {
  test("random garbage on many connections never takes the server down", async () => {
    const server = await start({
      // Random bytes are often merely *incomplete* rather than illegal — a
      // partial version line, or a length field promising more data. Those
      // are reaped by the grace timer, not by an immediate DISCONNECT, so
      // shorten it here to keep the test quick.
      loginGraceMs: 700,
      onSession(session) {
        session.write("alive");
        session.exit(0);
      },
    });
    const version = new TextEncoder().encode("SSH-2.0-fuzz\r\n");
    const probes: Promise<number>[] = [];
    for (let round = 0; round < 24; round++) {
      const junk = randomBytes(1 + Math.floor(Math.random() * 4096));
      // Half the rounds send a plausible version line first, so the fuzz
      // lands on the packet framer rather than the line scanner.
      probes.push(
        probe(server.port, round % 2 === 0 ? [version, junk] : [junk]),
      );
    }
    await Promise.all(probes);

    const client = ssh(server.port, keys.ed25519!, [], ["x"]);
    expect(new TextDecoder().decode(await client.stdout)).toBe("alive");
    expect(await client.proc.exited).toBe(0);
  }, 30_000);
});
