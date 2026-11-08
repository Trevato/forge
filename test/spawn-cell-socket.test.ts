/**
 * A websocket reaches an app in a child's cell (#7959): `forward` is a fetch,
 * which cannot carry an upgrade, so a handshake for the child's home or one
 * of its apps is opened to the cell first and answered second, as `proxyApp`
 * does for an app of this forge.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cellChildren } from "../src/spawn/cell.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let parent: App;
let servers: Servers;
let cell: ReturnType<typeof Bun.serve>;
const seen: { host: string | null; forwarded: string | null; protocols: string | null; path: string }[] = [];

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cell-socket-"));
  parent = createApp({ dataDir, url: "https://forge.test", port: 0 });
  mkdirSync(join(dataDir, "spawn"), { recursive: true });
  writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-k", done: true, placement: "cell", size: "small" }));
  writeFileSync(join(dataDir, "spawn", "down.json"), JSON.stringify({ name: "down", bodyId: "cell-d", done: true, placement: "cell", size: "small" }));
  cell = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        seen.push({
          host: request.headers.get("host"),
          forwarded: request.headers.get("x-forwarded-for"),
          protocols: request.headers.get("sec-websocket-protocol"),
          path: url.pathname + url.search,
        });
        if (server.upgrade(request, { data: null, headers: { "sec-websocket-protocol": "chat" } })) return undefined;
      }
      return new Response("plain", { status: 404 });
    },
    websocket: {
      open: (ws) => void ws.send("hello from the cell"),
      message: (ws, m) => void ws.send(`echo ${String(m)}`),
    },
  });
  const port = cell.port;
  (cellChildren(parent) as { get: unknown }).get = (id: string) => (id === "cell-k" ? { port } : undefined);
  servers = await serve(parent);
});

afterAll(() => {
  servers.stop();
  void cell.stop(true);
  parent.close();
});

const open = (host: string, path = "/ws?x=1", protocols: string[] = ["chat"]) =>
  new Promise<{ socket: WebSocket; frames: string[]; closed: Promise<number> } | string>((resolve) => {
    const socket = new WebSocket(`${servers.url.replace("http", "ws")}${path}`, { protocols, headers: { host } } as never);
    const frames: string[] = [];
    const closed = new Promise<number>((done) => socket.addEventListener("close", (e) => done(e.code)));
    socket.addEventListener("message", (e) => frames.push(String(e.data)));
    socket.addEventListener("open", () => resolve({ socket, frames, closed }), { once: true });
    socket.addEventListener("close", () => resolve("refused"), { once: true });
  });

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(20);
  if (!ok()) throw new Error(`never came: still waiting while !ok()`);
};

test("an app's socket in a cell: frames go both ways, with the app's own Host and path", async () => {
  const opened = await open("deal--kid--forge.test");
  if (typeof opened === "string") throw new Error("the socket did not open");
  await until(() => opened.frames.length > 0);
  expect(opened.frames[0]).toBe("hello from the cell");
  expect(opened.socket.protocol).toBe("chat");
  opened.socket.send("ping");
  await until(() => opened.frames.length > 1);
  expect(opened.frames[1]).toBe("echo ping");
  opened.socket.close(1000);
  await opened.closed;
  const last = seen.at(-1)!;
  expect(last.host).toBe("deal--kid--forge.test");
  expect(last.path).toBe("/ws?x=1");
  expect(last.protocols).toBe("chat");
});

test("the child's own host carries a socket too, and the cell hears the address the forge resolved", async () => {
  const opened = await open("kid--forge.test");
  if (typeof opened === "string") throw new Error("the socket did not open");
  await until(() => opened.frames.length > 0);
  expect(opened.frames[0]).toBe("hello from the cell");
  expect(seen.at(-1)!.host).toBe("kid--forge.test");
  expect(seen.at(-1)!.forwarded).not.toBeNull();
  opened.socket.close(1000);
  await opened.closed;
});

test("a path the cell does not upgrade is a refusal, and a cell that is not up is not a socket", async () => {
  expect(await open("deal--kid--forge.test", "/nope")).toBe("refused");
  expect(await open("deal--down--forge.test")).toBe("refused");
  expect(await open("deal--nobody--forge.test")).toBe("refused");
});
