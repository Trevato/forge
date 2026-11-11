/**
 * Websockets through the proxy (docs/APPS.md, "Hostnames and the proxy"):
 * a socket opened on an app's host reaches the app, frames go both ways
 * as they were sent, a close on either side closes the other, an app that
 * is not there answers with the forge's page instead of a socket that
 * shuts, a private app is as private over a socket as over a request, and
 * a frame past the limit ends the connection in either direction.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import {
  newApp,
  openEnvUrl,
  redeployEnv,
  stopEnv,
  updateAppSettings,
} from "../src/actions/apps.ts";
import { suspendAccount } from "../src/actions/accounts.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const MIB = 1024 * 1024;
/** The forge's frame limit for this file: the real one is 16 MiB, and moving that much three times took ~30 s under load (#1073). */
const LIMIT = 2 * MIB;

/**
 * The app under test: `/ws` echoes what it is sent, text as text and
 * binary as binary, after a binary greeting and one text frame that says
 * what the handshake looked like from where the app sits. It picks the
 * *last* subprotocol offered, so a client can tell the app's choice from
 * Bun's default (the first). `big:<n>` answers with n bytes, `close:<code>:
 * <reason>` closes from the app's side, and `/last-close` reports the
 * close the app last saw — the only way to look at the browser-to-app
 * direction from outside.
 */
const ECHO_SERVER = `const port = Number(process.env.PORT ?? "0");
let lastClose = "";
export const server = Bun.serve<{ seen: string }>({
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/headers")
      return Response.json({
        plat: [...request.headers.keys()].filter((k) => k.startsWith("x-plat-")),
        authorization: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
      });
    if (url.pathname === "/last-close") return new Response(lastClose);
    if (url.pathname === "/ws") {
      const offered = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const seen = JSON.stringify({
        path: url.pathname + url.search,
        host: request.headers.get("host"),
        cookie: request.headers.get("cookie"),
        plat: [...request.headers.keys()].filter((k) => k.startsWith("x-plat-")),
        authorization: request.headers.get("authorization"),
        identity: request.headers.get("x-forge-identity"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        forwardedProto: request.headers.get("x-forwarded-proto"),
        upgrade: request.headers.get("upgrade"),
        offered,
      });
      const chosen = offered.at(-1);
      const ok = server.upgrade(request, {
        data: { seen },
        ...(chosen === undefined
          ? {}
          : { headers: { "sec-websocket-protocol": chosen } }),
      });
      return ok ? undefined : new Response("no", { status: 400 });
    }
    return new Response("ws echo", { status: url.pathname === "/" ? 200 : 404 });
  },
  websocket: {
    open(ws) {
      ws.send(new Uint8Array([1, 2, 3]));
      ws.send("seen:" + ws.data.seen);
    },
    message(ws, message) {
      if (typeof message === "string" && message.startsWith("big:")) {
        ws.send(new Uint8Array(Number(message.slice(4))));
        return;
      }
      if (typeof message === "string" && message.startsWith("close:")) {
        const [code, reason] = message.slice(6).split(":");
        ws.close(Number(code), reason);
        return;
      }
      ws.send(message);
    },
    close(_ws, code, reason) {
      lastClose = code + " " + reason;
    },
  },
});
`;

const ECHO_TEST = `import { expect, test } from "bun:test";
process.env.PORT = "0";
const { server } = await import("./server.ts");
test("serves the page", async () => {
  const response = await fetch(\`http://\${server.hostname}:\${server.port}/\`);
  expect(response.status).toBe(200);
});
`;

describe("apps: websockets through the proxy", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let grantName = "";
  const DOMAIN = "apps.test";
  const HOST = `wsecho.${DOMAIN}`;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), host },
      redirect: "manual",
    });

  /** A handshake-shaped request the forge will answer with HTTP, not a socket. */
  const handshake = (
    host: string,
    path: string,
    headers: Record<string, string> = {},
  ) =>
    viaHost(host, path, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        ...headers,
      },
    });

  /** A websocket client through the forge, addressed by `Host`. */
  function connect(
    path: string,
    options: { headers?: Record<string, string>; protocols?: string[] } = {},
  ) {
    const ws = new WebSocket(`ws://localhost:${servers.port}${path}`, {
      headers: { host: HOST, ...options.headers },
      protocols: options.protocols ?? [],
    });
    ws.binaryType = "arraybuffer";
    const frames: (string | ArrayBuffer)[] = [];
    const waiting: (() => void)[] = [];
    ws.addEventListener("message", (event) => {
      frames.push(event.data as string | ArrayBuffer);
      for (const wake of waiting.splice(0)) wake();
    });
    ws.addEventListener("error", () => {});
    const opened = new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("close", () => resolve(false));
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      ),
    );
    const next = (): Promise<string | ArrayBuffer> =>
      new Promise((resolve, reject) => {
        if (frames.length > 0) return resolve(frames.shift()!);
        waiting.push(() => resolve(frames.shift()!));
        void closed.then(() => reject(new Error("closed before a frame")));
      });
    return { ws, opened, closed, next };
  }

  const bytes = (frame: string | ArrayBuffer): number[] =>
    typeof frame === "string" ? [] : Array.from(new Uint8Array(frame));

  /** What the app saw of the handshake, from its first text frame. */
  const seenBy = async (
    next: () => Promise<string | ArrayBuffer>,
  ): Promise<Record<string, unknown>> => {
    expect(bytes(await next())).toEqual([1, 2, 3]);
    const frame = await next();
    expect(typeof frame).toBe("string");
    expect(frame).toStartWith("seen:");
    return JSON.parse((frame as string).slice(5)) as Record<string, unknown>;
  };

  async function settled(
    where: (run: Run) => boolean,
    timeoutMs = 60_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        where,
      );
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(100);
    }
    throw new Error("run did not settle in time");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apps-ws-"));
    app = createApp({ dataDir, port: 0, wsMaxMessage: LIMIT });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;

    const made = await newApp(app, alice, {
      name: "wsecho",
      description: "An echo over a socket",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    repo = made.value.repo;
    grantName = `forge_grant_${made.value.app.id.slice(-8)}`;
    await settled((run) => run.env === "production");
    // The scaffold becomes the echo app; the push redeploys production.
    const committed = await commitToBranch(app, alice, repo, {
      message: "Echo over a websocket",
      files: [
        { path: "src/server.ts", content: ECHO_SERVER },
        { path: "src/server.test.ts", content: ECHO_TEST },
        // The scaffold's suites that boot its real server go with it.
        { path: "src/audit.test.ts", content: null },
        { path: "src/openapi.test.ts", content: null },
        { path: "src/security.test.ts", content: null },
        { path: "src/site.test.ts", content: null },
      ],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const run = await settled(
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    if (run.state !== "ok") throw new Error(`deploy failed: ${run.summary}`);
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a greeting the app sends the moment its socket opens reaches the browser, in order, before the browser has said anything", async () => {
    // The echo app sends two frames synchronously in its own `open` — they
    // ride out with the 101 in the same write — so this is the earliest a
    // frame can exist. The browser sends nothing until both have arrived.
    const client = connect("/ws");
    expect(await client.opened).toBe(true);
    expect(bytes(await client.next())).toEqual([1, 2, 3]);
    const second = await client.next();
    expect(typeof second).toBe("string");
    expect(second).toStartWith("seen:");
    // And only then does anything of the browser's come back.
    client.ws.send("after the greeting");
    expect(await client.next()).toBe("after the greeting");
    client.ws.close();
  });

  test("frames go both ways as they were sent, and the app sees the handshake it would have seen", async () => {
    const client = connect("/ws?room=1", {
      protocols: ["a", "b"],
      headers: { cookie: "sid=abc" },
    });
    expect(await client.opened).toBe(true);
    // The app's choice, not the first offered.
    expect(client.ws.protocol).toBe("b");

    const seen = await seenBy(client.next);
    expect(seen["path"]).toBe("/ws?room=1");
    expect(seen["host"]).toBe(HOST);
    expect(seen["cookie"]).toBe("sid=abc");
    expect(seen["forwardedHost"]).toBe(HOST);
    expect(seen["forwardedProto"]).toBe("http");
    expect(seen["upgrade"]).toBe("websocket");
    expect(seen["offered"]).toEqual(["a", "b"]);

    client.ws.send("hello");
    expect(await client.next()).toBe("hello");
    client.ws.send(new Uint8Array([9, 8, 7]));
    expect(bytes(await client.next())).toEqual([9, 8, 7]);
    // A real frame, not a toy: a megabyte of text, intact.
    const long = "x".repeat(MIB);
    client.ws.send(long);
    expect(await client.next()).toBe(long);
    // Text is text and binary is binary, whatever the bytes spell.
    client.ws.send(new TextEncoder().encode("hello"));
    expect(bytes(await client.next())).toEqual([104, 101, 108, 108, 111]);

    client.ws.close(1000, "done");
    expect((await client.closed).code).toBe(1000);
  });

  const forgeHeaders = () => ({
    "x-plat-edge-token": "edge-secret",
    "x-plat-user": "admin",
    authorization: "Bearer forge-token",
    cookie: "sid=abc; forge_session=hosted-forge-login; forge_grant_zzzzzzzz=hosted;",
  });

  test("a request through the proxy reaches the app without the forge's or the edge's credentials, and a hosted forge's own cookies survive", async () => {
    const res = await viaHost(HOST, "/headers", {
      headers: {
        ...forgeHeaders(),
        cookie: `sid=abc; ${grantName}=ours; forge_session=hosted; forge_grant_zzzzzzzz=hosted`,
      },
    });
    const seen = (await res.json()) as Record<string, unknown>;
    expect(seen["plat"]).toEqual([]);
    expect(seen["authorization"]).toBeNull();
    expect(seen["cookie"]).toBe(
      "sid=abc; forge_session=hosted; forge_grant_zzzzzzzz=hosted",
    );
  });

  test("a websocket handshake reaches the app without the forge's or the edge's credentials", async () => {
    const client = connect("/ws", {
      headers: {
        ...forgeHeaders(),
        cookie: `sid=abc; ${grantName}=ours; forge_session=hosted`,
      },
    });
    expect(await client.opened).toBe(true);
    const seen = await seenBy(client.next);
    expect(seen["plat"]).toEqual([]);
    expect(seen["authorization"]).toBeNull();
    expect(seen["cookie"]).toBe("sid=abc; forge_session=hosted");
    client.ws.close();
  });

  test("a close on either side reaches the other, code and reason intact", async () => {
    // From the app.
    const fromApp = connect("/ws");
    expect(await fromApp.opened).toBe(true);
    await seenBy(fromApp.next);
    fromApp.ws.send("close:4002:app said so");
    expect(await fromApp.closed).toEqual({ code: 4002, reason: "app said so" });

    // From the browser. The code arrives; the reason is asserted only on
    // the way *from* the app, because Bun's own client — the forge's side
    // toward the app, and this test's — drops a reason longer than a byte.
    const fromBrowser = connect("/ws");
    expect(await fromBrowser.opened).toBe(true);
    await seenBy(fromBrowser.next);
    fromBrowser.ws.close(4003, "leaving");
    await fromBrowser.closed;
    expect(await lastClose()).toStartWith("4003");

    // A browser that vanishes without a close frame is a 1001 to the app —
    // "going away" — not a silent disappearance.
    const vanishing = connect("/ws");
    expect(await vanishing.opened).toBe(true);
    await seenBy(vanishing.next);
    vanishing.ws.terminate();
    await vanishing.closed;
    expect(await lastClose()).toStartWith("1001");
  });

  /** The app's account of the last close, once it has one. */
  async function lastClose(): Promise<string> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const text = await (await viaHost(HOST, "/last-close")).text();
      if (text !== "") return text;
      await Bun.sleep(25);
    }
    return "";
  }

  test("a frame past the limit ends the connection, in either direction", async () => {
    // From the browser: refused before it reaches the app.
    const inbound = connect("/ws");
    expect(await inbound.opened).toBe(true);
    await seenBy(inbound.next);
    inbound.ws.send(new Uint8Array(LIMIT + 1));
    expect((await inbound.closed).code).not.toBe(1000);

    // From the app: the forge will not carry it.
    const outbound = connect("/ws");
    expect(await outbound.opened).toBe(true);
    await seenBy(outbound.next);
    outbound.ws.send(`big:${LIMIT + 1}`);
    expect(await outbound.closed).toEqual({
      code: 1009,
      reason: "message too big",
    });
    expect(await lastClose()).toStartWith("1009");

    // At the limit is not past it, from either side.
    const atLimit = connect("/ws");
    expect(await atLimit.opened).toBe(true);
    await seenBy(atLimit.next);
    atLimit.ws.send(`big:${LIMIT}`);
    expect(bytes(await atLimit.next()).length).toBe(LIMIT);
    atLimit.ws.send(new Uint8Array(LIMIT));
    expect(bytes(await atLimit.next()).length).toBe(LIMIT);
    atLimit.ws.close();
  }, 30_000);

  test("a handshake the app does not accept is the forge's page, never a socket that shuts", async () => {
    const page = await handshake(HOST, "/nope");
    expect(page.status).toBe(502);
    expect(await page.text()).toContain(
      "the app did not accept a websocket at this path",
    );
    // A real client sees the refusal as a failed handshake, not an open.
    const client = connect("/nope");
    expect(await client.opened).toBe(false);
  });

  test("a request that only claims to upgrade is an ordinary request", async () => {
    const claimed = await viaHost(HOST, "/", {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.text()).toBe("ws echo");
    // The hostname gate comes first, socket or not.
    expect((await handshake(`nothing.${DOMAIN}`, "/ws")).status).toBe(404);
  });

  test("a private app refuses an ungranted socket and admits a granted one", async () => {
    expect(updateAppSettings(app, alice, repo, { access: "private" }).ok).toBe(
      true,
    );
    try {
      // No cookie: the same 404 as a page.
      const refused = await handshake(HOST, "/ws");
      expect(refused.status).toBe(404);
      const client = connect("/ws");
      expect(await client.opened).toBe(false);
      // A forged cookie is no cookie.
      const forged = connect("/ws", {
        headers: { cookie: "forge_grant=x.production.9999999999999.AAAA" },
      });
      expect(await forged.opened).toBe(false);

      // The forge vouches for alice; the grant cookie opens the socket.
      const link = openEnvUrl(app, alice, repo, "production");
      expect(link.ok).toBe(true);
      if (!link.ok) return;
      const url = new URL(link.value);
      const granted = await viaHost(url.host, `${url.pathname}${url.search}`);
      expect(granted.status).toBe(303);
      const cookie = (granted.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect(cookie).toStartWith("forge_grant_");
      const admitted = connect("/ws", { headers: { cookie } });
      expect(await admitted.opened).toBe(true);
      await seenBy(admitted.next);
      admitted.ws.send("private hello");
      expect(await admitted.next()).toBe("private hello");
      admitted.ws.close();

      // A grant for production is no grant for a preview.
      const elsewhere = await handshake(`wsecho--9.${DOMAIN}`, "/ws", {
        cookie,
      });
      expect(elsewhere.status).toBe(404);
    } finally {
      updateAppSettings(app, alice, repo, { access: "public" });
    }
  });

  test("a visitor's socket closes when their account is suspended; the app and others' sockets go on", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username: "visitor",
      email: "visitor@forge.local",
      password: "a-visitor-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const link = openEnvUrl(app, made.value, repo, "production");
    if (!link.ok) throw new Error(String(link.error));
    const url = new URL(link.value);
    const granted = await viaHost(url.host, `${url.pathname}${url.search}`);
    expect(granted.status).toBe(303);
    const cookie = (granted.headers.get("set-cookie") ?? "").split(";")[0]!;
    const visitor = connect("/ws", { headers: { cookie } });
    expect(await visitor.opened).toBe(true);
    await seenBy(visitor.next);
    const stranger = connect("/ws");
    expect(await stranger.opened).toBe(true);
    await seenBy(stranger.next);

    expect((await suspendAccount(app, alice, "visitor")).ok).toBe(true);
    expect((await visitor.closed).code).toBe(1008);
    // Only that account's: the app is not the suspended one's, and a
    // stranger's socket on it still talks.
    stranger.ws.send("still here");
    expect(await stranger.next()).toBe("still here");
    stranger.ws.close();
    // And the grant it still holds opens nothing for a person who may not.
    const again = connect("/ws", { headers: { cookie } });
    if (await again.opened) {
      const seen = await seenBy(again.next);
      expect(seen["identity"]).toBeNull();
      again.ws.close();
    }
  });

  test("an app that stops closes its sockets, and the next handshake gets the page", async () => {
    const client = connect("/ws");
    expect(await client.opened).toBe(true);
    await seenBy(client.next);
    const stopped = await stopEnv(app, alice, repo, "production");
    expect(stopped.ok).toBe(true);
    try {
      // 1001, "going away"; Bun's own client reports the code as 1000 and
      // keeps the reason, so the reason is what is asserted.
      expect((await client.closed).reason).toBe("the app stopped answering");

      const page = await handshake(HOST, "/ws");
      expect(page.status).toBe(502);
      expect(await page.text()).toContain("not running");
    } finally {
      // The tests run in any order (the gate shuffles them): the app comes
      // back up for whichever runs next.
      const again = await redeployEnv(app, alice, repo, "production");
      if (!again.ok || again.value === undefined)
        throw new Error("the app could not be brought back");
      const id = again.value.id;
      const run = await settled((r) => r.id === id);
      if (run.state !== "ok") throw new Error(`redeploy failed: ${run.summary}`);
    }
  }, 90_000);
});
