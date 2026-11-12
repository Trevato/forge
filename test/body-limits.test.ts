import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { STRANGER_MAX } from "../src/http/limits.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

// No request a stranger can make has the forge read an unbounded body: a
// declared length and an undeclared (chunked) one are both stopped at the
// route's cap, and a refused body ends its connection instead of riding
// on into the next request.
interface RawOutcome {
  text: string;
  closedByServer: boolean;
  ms: number;
}

describe("request body limits", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let port: number;
  let ownerToken: string;
  /** Connections the server must end, started together in beforeAll. */
  let hangups: Record<
    "stranger" | "endless" | "endlessUnread",
    Promise<RawOutcome>
  >;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-body-limits-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    port = servers.port;
    const owner = await seedAdmin(app, {
      username: "ada",
      email: "ada@f.dev",
      password: "owner-passphrase",
    });
    if (!owner.ok) throw new Error(owner.error);
    ownerToken = createToken(app.db, owner.value.id, "t", "admin").token;
    const repo = await createRepo(app, owner.value, {
      name: "garden",
      visibility: "public",
    });
    if (!repo.ok) throw new Error(repo.error);
    // The listener ends a connection with \`server.timeout(request, 1)\`,
    // and the runtime fires socket timeouts on a 4-second tick: each
    // connection the server hangs up on costs up to 4 s of waiting,
    // whatever the client sends. The three are started together here and
    // awaited by their tests, so the file waits for that tick once.
    hangups = {
      stranger: raw(
        pump(
          chunkedPost("/api/v1/fleet/ops", "application/json"),
          3 * 1024 * 1024,
          1,
        ),
        10_000,
      ),
      endless: raw(
        pump(chunkedPost("/oauth/register", "application/json"), Infinity, 5),
        30_000,
      ),
      endlessUnread: raw(
        pump(
          chunkedPost(
            "/ada/garden.git/git-receive-pack",
            "application/x-git-receive-pack-request",
          ),
          Infinity,
          5,
        ),
        30_000,
      ),
    };
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A body of `n` bytes sent with no declared length (chunked). */
  const chunked = (n: number, text = "x"): ReadableStream<Uint8Array> => {
    let left = n;
    return new ReadableStream({
      pull(controller) {
        if (left <= 0) return controller.close();
        const size = Math.min(left, 16 * 1024);
        left -= size;
        controller.enqueue(
          new TextEncoder().encode(text.repeat(size).slice(0, size)),
        );
      },
    });
  };
  const big = STRANGER_MAX * 4;

  const routes: { name: string; path: string; type: string }[] = [
    { name: "signup (API)", path: "/api/v1/users", type: "application/json" },
    {
      name: "a session (API)",
      path: "/api/v1/sessions",
      type: "application/json",
    },
    {
      name: "a token by password (API)",
      path: "/api/v1/tokens",
      type: "application/json",
    },
    {
      name: "OAuth client registration",
      path: "/oauth/register",
      type: "application/json",
    },
    {
      name: "a report from outside (API)",
      path: "/api/v1/repos/ada/garden/reports",
      type: "application/json",
    },
    {
      name: "the signup form",
      path: "/signup",
      type: "application/x-www-form-urlencoded",
    },
    {
      name: "the report form",
      path: "/ada/garden/report",
      type: "application/x-www-form-urlencoded",
    },
  ];

  for (const route of routes) {
    test(`${route.name}: a declared oversize body is refused with 413`, async () => {
      const res = await fetch(`${base}${route.path}`, {
        method: "POST",
        headers: { "content-type": route.type, origin: base },
        body: "x".repeat(big),
      });
      expect(res.status).toBe(413);
    });

    test(`${route.name}: an undeclared (chunked) oversize body is refused with 413`, async () => {
      const res = await fetch(`${base}${route.path}`, {
        method: "POST",
        headers: { "content-type": route.type, origin: base },
        body: chunked(big),
        duplex: "half",
      });
      expect(res.status).toBe(413);
    });
  }

  /** Raw bytes on one connection; resolves with what came back, and how. */
  const raw = (
    write: (socket: ReturnType<typeof connect>) => void,
    waitMs = 2000,
  ): Promise<RawOutcome> =>
    new Promise((resolve) => {
      const started = Date.now();
      const socket = connect(port, "127.0.0.1");
      let text = "";
      let done = false;
      socket.on("data", (d) => (text += d.toString()));
      socket.on("error", () => {});
      socket.on("close", () => {
        if (done) return;
        done = true;
        resolve({ text, closedByServer: true, ms: Date.now() - started });
      });
      socket.on("connect", () => write(socket));
      setTimeout(() => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve({ text, closedByServer: false, ms: Date.now() - started });
      }, waitMs);
    });

  /**
   * A chunked request: `head`, then a 64 KiB chunk every `everyMs` until
   * `total` bytes are sent and the body ends — or, when `total` is
   * Infinity, until the server hangs up. Streamed, not one write: a single
   * large write races the answer with EPIPE on the still-flushing send
   * buffer and the client sees nothing.
   */
  const pump =
    (head: string, total: number, everyMs: number) =>
    (socket: ReturnType<typeof connect>): void => {
      const chunk = "x".repeat(64 * 1024);
      let left = total;
      socket.write(head);
      const timer = setInterval(() => {
        if (socket.destroyed) return clearInterval(timer);
        if (left <= 0) {
          socket.write(`0\r\n\r\n`);
          return clearInterval(timer);
        }
        const n = Math.min(left, chunk.length);
        left -= n;
        socket.write(`${n.toString(16)}\r\n${chunk.slice(0, n)}\r\n`);
      }, everyMs);
    };
  const chunkedPost = (path: string, type: string): string =>
    `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: ${type}\r\nTransfer-Encoding: chunked\r\n\r\n`;

  test("a request after a refused chunked body on the same connection is never misanswered", async () => {
    // Invariant: a refused chunked body is drained, so the request behind
    // it on the same connection is answered as itself (413, then 200).
    // The trailing request asks to close, so the test ends on its answer
    // instead of waiting out a kept-alive connection.
    const body = "x".repeat(big);
    const out = await raw((s) =>
      s.write(
        chunkedPost("/oauth/register", "application/json") +
          `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n` +
          `GET /api/v1/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      ),
    );
    // Not anchored to a line: a body with no newline runs into the next
    // status line.
    const statuses = [...out.text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(
      (m) => m[1],
    );
    // The rest of the refused body is drained, so the connection stays
    // framed: the request behind it is answered as itself, never misread
    // out of the body as a bare 400.
    expect(statuses).toEqual(["413", "200"]);
  });

  test("the next request on a reused connection after a refused body is read as itself", async () => {
    // Bun's own fetch reuses a connection whatever the answer says; the
    // forge must not depend on a client honouring "Connection: close".
    const refused = await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunked(big),
    });
    expect(refused.status).toBe(413);
    const next = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "wrong-passphrase" }),
    });
    expect(next.status).toBe(401);
  });

  test("an Idempotency-Key does not buy a read past the cap", async () => {
    const res = await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "big-body-once",
      },
      body: chunked(20 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });

  test("a fetch's compressed negotiation that inflates past its cap stops there", async () => {
    // A few dozen kilobytes that would inflate to 64 MiB.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(STRANGER_MAX);
    const res = await fetch(`${base}/ada/garden.git/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
      },
      body: bomb,
    }).catch(() => undefined);
    // Either the stream is cut or git answers a short error; the forge is
    // still up and answering.
    if (res !== undefined) await res.arrayBuffer().catch(() => undefined);
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
  });

  test("a large authenticated push still works", async () => {
    const work = await mkdtemp(join(tmpdir(), "forge-body-push-"));
    try {
      const env = gitClientEnv({
        GIT_AUTHOR_NAME: "O",
        GIT_AUTHOR_EMAIL: "o@f.dev",
        GIT_COMMITTER_NAME: "O",
        GIT_COMMITTER_EMAIL: "o@f.dev",
      });
      const git = async (args: string[]) =>
        await Bun.spawn(["git", ...args], {
          cwd: work,
          env,
          stdout: "ignore",
          stderr: "ignore",
        }).exited;
      expect(await git(["init", "-q", "-b", "main"])).toBe(0);
      // Random bytes do not compress: the pack is as big as the file.
      await writeFile(
        join(work, "blob.bin"),
        crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024)),
      );
      expect(await git(["add", "."])).toBe(0);
      expect(await git(["commit", "-q", "-m", "big"])).toBe(0);
      const remote = `${base.replace("http://", `http://ada:${ownerToken}@`)}/ada/garden.git`;
      expect(await git(["push", "-q", remote, "main"])).toBe(0);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // These three await the connections started in beforeAll; last in the
  // file, so every test above runs while the runtime's timer comes round.
  test("a stranger gets the stranger's cap on a route that reads its body before asking who is calling", async () => {
    // Invariant: an anonymous body past STRANGER_MAX + DRAIN_MAX is
    // answered and its connection ended by the server, on a route that
    // reads first and asks who is calling after.
    // POST /api/v1/fleet/ops reads its body, then refuses an anonymous
    // caller. 3 MiB is under the signed-in cap (16 MiB) and well past the
    // stranger's (64 KiB) plus the drain budget: the forge stops reading
    // and ends the connection instead of reading it all to say 401.
    const out = await hangups.stranger;
    expect(out.text).toMatch(/^HTTP\/1\.1 (401|413)/);
    expect(out.text.toLowerCase()).toContain("connection: close");
    expect(out.closedByServer).toBe(true);
  }, 15_000);

  test("a chunked body that never ends is cut off, not read until the idle timeout", async () => {
    // Invariant: a body that never ends, on a route that reads it, is
    // answered 413 and its connection ended long before the idle timeout.
    const out = await hangups.endless;
    expect(out.text).toStartWith("HTTP/1.1 413");
    expect(out.closedByServer).toBe(true);
    // Long before the 120 s idle timeout, with room for a loaded machine.
    expect(out.ms).toBeLessThan(20_000);
  }, 30_000);

  test("an endless body a route never reads is cut off too (an anonymous push)", async () => {
    // Invariant: a body that never ends, on a route that never reads it,
    // is answered and its connection ended long before the idle timeout.
    const out = await hangups.endlessUnread;
    expect(out.text).toMatch(/^HTTP\/1\.1 40[14]/);
    expect(out.closedByServer).toBe(true);
    // Long before the 120 s idle timeout, with room for a loaded machine.
    expect(out.ms).toBeLessThan(20_000);
  }, 30_000);
});
