/**
 * `ssh forge.example` end to end: the real OpenSSH client, a real pty, the
 * real listener, and the terminal UI on the other side.
 *
 * Plus the one piece of `src/ssh` the app forced: a channel that can tell a
 * producer to wait. Git's stdout outruns the peer's window during a clone, so
 * without `drain()` the queue grows to the size of the pack.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { addSshKey, signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { Channels, type SshSession } from "../src/ssh/channels.ts";
import { MSG, Writer } from "../src/ssh/wire.ts";
import { createLog } from "../src/kernel/log.ts";
import { serveForgeSsh } from "../src/tui/ssh.ts";
import type { SshServer } from "../src/ssh/server.ts";

setLogLevel("error");
const log = createLog("ssh-app-test");

const SSH = "/usr/bin/ssh";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";

/** Strip SGR, cursor moves and the rest of what a TUI paints. */
function plain(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>]/g, "");
}

async function keygen(path: string): Promise<string> {
  const proc = Bun.spawn(
    [SSH_KEYGEN, "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  return (await readFile(`${path}.pub`, "utf8")).trim();
}

/** Run the TUI over ssh, quit it, and return everything it painted. */
async function connect(
  port: number,
  key: string,
  user = "git",
): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(
    [
      SSH,
      "-tt",
      "-p",
      String(port),
      "-i",
      key,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=5",
      `${user}@127.0.0.1`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new Response(proc.stdout)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer));
  // Give the first frame time to arrive, then quit from the root screen.
  await Bun.sleep(900);
  proc.stdin.write("q");
  await proc.stdin.flush();
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return { out: plain(await stdout), code };
}

describe("ssh into the forge", () => {
  let dataDir: string;
  let keyDir: string;
  let forge: Forge;
  let server: SshServer;
  let aliceKey = "";
  let strangerKey = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sshapp-"));
    keyDir = await mkdtemp(join(tmpdir(), "forge-sshkeys-"));
    forge = createApp({ dataDir, port: 0 });
    const alice = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!alice.ok) throw new Error("signup failed");
    await createRepo(forge, alice.value, {
      name: "lighthouse",
      visibility: "public",
    });
    await createRepo(forge, alice.value, { name: "vault" });

    aliceKey = join(keyDir, "alice");
    strangerKey = join(keyDir, "stranger");
    const line = await keygen(aliceKey);
    await keygen(strangerKey);
    const added = addSshKey(forge, alice.value, { name: "laptop", key: line });
    if (!added.ok) throw new Error("key registration failed");

    server = await serveForgeSsh(forge, { port: 0, hostname: "127.0.0.1" });
  });

  afterAll(async () => {
    server.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(keyDir, { recursive: true, force: true });
  });

  test("the listener's port is published on the app config", () => {
    expect(forge.config.sshPort).toBe(server.port);
    expect(server.hostKey.fingerprint.startsWith("SHA256:")).toBe(true);
  });

  test("a linked key lands on that user's dashboard", async () => {
    const { out } = await connect(server.port, aliceKey);
    expect(out).toContain("forge");
    expect(out).toContain("alice");
    expect(out).toContain("alice/lighthouse");
    expect(out).toContain("alice/vault");
  });

  test("an unknown key is a guest, with a way to sign in", async () => {
    const { out } = await connect(server.port, strangerKey);
    // The breadcrumb names the session, and a guest is a guest.
    expect(out).toContain("Guest");
    expect(out).toContain("alice/lighthouse");
    // A private repo is not in the list a guest was handed.
    expect(out).not.toContain("vault");
  });
});

describe("channel write backpressure", () => {
  /** A channel whose peer granted a tiny window — the clone case, in small. */
  function harness(remoteWindow: number) {
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
    channels.handle(
      new Writer(64)
        .u8(MSG.CHANNEL_OPEN)
        .string("session")
        .u32(9)
        .u32(remoteWindow)
        .u32(32768)
        .build(),
      0,
    );
    channels.handle(
      new Writer(64)
        .u8(MSG.CHANNEL_REQUEST)
        .u32(1)
        .string("exec")
        .bool(true)
        .string("git-upload-pack '/a/b.git'")
        .build(),
      1,
    );
    return { channels, sent, session: session! };
  }

  test("pending reports what the window has not let out, and drain waits", async () => {
    const h = harness(16);
    expect(h.session.pending).toBe(0);
    expect(h.session.drain()).resolves.toBeUndefined();

    h.session.write(new Uint8Array(64));
    // Only the 16 bytes of credit went out; the rest is still queued.
    expect(h.session.pending).toBe(48);

    let drained = false;
    void h.session.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(1);
    expect(drained).toBe(false);

    h.channels.handle(
      new Writer(32).u8(MSG.CHANNEL_WINDOW_ADJUST).u32(1).u32(1024).build(),
      2,
    );
    await Bun.sleep(1);
    expect(h.session.pending).toBe(0);
    expect(drained).toBe(true);
  });

  test("a peer that closes releases a waiting writer rather than hanging it", async () => {
    const h = harness(0);
    h.session.write(new Uint8Array(32));
    let drained = false;
    void h.session.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(1);
    expect(drained).toBe(false);

    h.channels.handle(new Writer(16).u8(MSG.CHANNEL_CLOSE).u32(1).build(), 3);
    await Bun.sleep(1);
    expect(drained).toBe(true);
  });
});
