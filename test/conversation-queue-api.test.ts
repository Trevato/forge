/**
 * The doors to queue and steer (#8819): the API's `during`, its queue limit,
 * Cancel by DELETE and by the page's form, the `queued` list, the held file,
 * the stream's `queued` frame, and `ssh talk /queue|/steer|/queued|/unqueue`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { configureConversation, conversationOptions, QUEUE_MAX, queuedOf, say, stopTurn, turnRunning } from "../src/crew/conversation.ts";
import { storeFile } from "../src/core/conversation_files.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";
import { parseDuring } from "../src/tui/ssh-talk.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo alice";

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let rw: string;
let ro: string;
let bob: string;

const headers = (t: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", authorization: `Bearer ${t}`, ...extra });
const send = (body: object, t = rw, extra: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/conversation/messages`, { method: "POST", headers: headers(t, extra), body: JSON.stringify(body) });
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(10);
  if (!ok()) throw new Error(`never came: still waiting while !ok()`);
};
/** Starts a turn that holds until stopped, without counting against the minute's messages. */
const start = async () => {
  say(app, conversationOptions(app)!, alice.id, "go", [], "queue");
  await until(() => turnRunning(app, alice.id));
};
/** Ends whatever runs, and what waits, so the next test starts clean. */
const clear = async () => {
  stopTurn(app, alice.id);
  await until(() => !turnRunning(app, alice.id));
};
const exec = async (command: string) => {
  const parsed = parseAuthorizedKey(KEY);
  if (!parsed.ok) throw new Error("key");
  let out = "";
  let err = "";
  let code: number | undefined;
  await new Promise<void>((resolve) => {
    forgeSshSession(app)({
      key: { fingerprint: fingerprint(parsed.value.blob), line: KEY },
      username: "whoever",
      remoteAddress: "203.0.113.9",
      kind: "exec",
      command,
      term: undefined,
      env: {},
      cols: 0,
      rows: 0,
      widthPx: 0,
      heightPx: 0,
      ended: false,
      pending: 0,
      write: (d: Uint8Array | string) => void (out += typeof d === "string" ? d : Buffer.from(d).toString()),
      writeStderr: (d: string) => void (err += d),
      onData() {},
      onResize() {},
      onEof() {},
      onClose() {},
      exit(c: number) {
        code ??= c;
        resolve();
      },
      drained: async () => {},
    } as never);
  });
  return { out, err, code };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-conv-queue-api-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const other = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!other.ok) throw new Error(other.error);
  const parsed = parseAuthorizedKey(KEY);
  if (!parsed.ok) throw new Error("key");
  addKey(app.db, alice.id, "laptop", parsed.value);
  rw = createToken(app.db, alice.id, "personal", "rw").token;
  ro = createToken(app.db, alice.id, "personal", "ro").token;
  bob = createToken(app.db, other.value.id, "personal", "rw").token;
  // Holds each run until stopped: the turn is "running" for as long as a test needs.
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi\nIFS= read -r first\necho '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'\nsleep 30\n`);
  chmodSync(bin, 0o755);
  configureConversation(app, { binary: bin, localUrl: servers.url, budgetUsd: 1, timeoutMs: 60_000, signal: new AbortController().signal });
});
afterAll(async () => {
  await clear();
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("queue and steer through the doors", () => {
  test("`during` is queue or steer; a queued message is listed, a sixth is refused, and DELETE takes one back", async () => {
    await start();
    expect(((await (await send({ text: "x", during: "later" })).json()) as { error: string }).error).toBe("invalid_during");
    expect((await send({ text: "x", during: 5 })).status).toBe(422);
    const ids: string[] = [];
    for (let i = 0; i < QUEUE_MAX; i++) {
      const res = await send({ text: `wait ${i}`, during: "queue" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { how: string; queued: string };
      expect(body.how).toBe("queued");
      ids.push(body.queued);
    }
    const full = await send({ text: "one too many", during: "queue" });
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: string }).error).toBe("queue_full");
    const listed = (await (await fetch(`${servers.url}/api/v1/conversation/turns`, { headers: headers(rw) })).json()) as { queued: { id: string; text: string }[] };
    expect(listed.queued.map((q) => q.text)).toEqual(["wait 0", "wait 1", "wait 2", "wait 3", "wait 4"]);
    const del = (id: string, t: string | undefined, extra: Record<string, string> = {}) =>
      fetch(`${servers.url}/api/v1/conversation/queue/${id}`, { method: "DELETE", headers: t === undefined ? extra : headers(t, extra) });
    expect((await del(ids[0]!, undefined)).status).toBe(401);
    expect((await del(ids[0]!, rw, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await del(ids[0]!, ro)).status).toBe(403);
    expect((await del(ids[0]!, bob)).status).toBe(404);
    expect(queuedOf(app, alice.id)).toHaveLength(QUEUE_MAX);
    expect((await del(ids[0]!, rw)).status).toBe(200);
    expect((await del(ids[0]!, rw)).status).toBe(404);
    expect(queuedOf(app, alice.id)).toHaveLength(QUEUE_MAX - 1);
    await clear();
  });

  test("steer by POST stops the turn and sends the message at once", async () => {
    await start();
    say(app, conversationOptions(app)!, alice.id, "after", [], "queue");
    const res = await send({ text: "now", during: "steer" });
    expect(((await res.json()) as { how: string }).how).toBe("interrupted");
    // The queue holds the steering message ahead of the one that waited, until the stopped turn ends.
    await until(() => queuedOf(app, alice.id).length === 1);
    expect(queuedOf(app, alice.id).map((q) => q.text)).toEqual(["after"]);
    await clear();
  });

  test("a file in a queued message is held: not removable, not sent twice", async () => {
    await start();
    const file = storeFile(app.db, dir, alice.id, "n.txt", new TextEncoder().encode("notes"));
    if (!file.ok) throw new Error(file.error);
    expect((await send({ text: "with file", during: "queue", files: [file.value.id] })).status).toBe(202);
    expect((await send({ text: "same file", during: "queue", files: [file.value.id] })).status).toBe(409);
    const del = await fetch(`${servers.url}/api/v1/conversation/files/${file.value.id}`, { method: "DELETE", headers: headers(rw) });
    expect(del.status).toBe(409);
    await clear();
  });

  test("the page's Cancel is a post form that works without the script, for the signed-in owner only", async () => {
    await start();
    const queued = say(app, conversationOptions(app)!, alice.id, "hold on", [], "queue");
    const id = queued.ok ? queued.value.queued : "";
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const page = await (await fetch(`${servers.url}/talk`, { headers: { cookie } })).text();
    expect(page).toContain(`action="/talk/queue/${id}/cancel"`);
    expect(page).toContain("hold on");
    const cancel = (extra: Record<string, string>) =>
      fetch(`${servers.url}/talk/queue/${id}/cancel`, { method: "POST", redirect: "manual", headers: { cookie, ...extra }, body: new URLSearchParams() });
    expect((await cancel({ origin: "https://elsewhere.example" })).status).toBe(403);
    expect(queuedOf(app, alice.id)).toHaveLength(1);
    expect((await cancel({ origin: servers.url })).status).toBe(303);
    expect(queuedOf(app, alice.id)).toHaveLength(0);
    expect((await cancel({ origin: servers.url, accept: "application/json" })).status).toBe(404);
    await clear();
  });

  test("the stream tells every viewer what waits", async () => {
    await start();
    say(app, conversationOptions(app)!, alice.id, "seen on another tab", [], "queue");
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const abort = new AbortController();
    const res = await fetch(`${servers.url}/talk/stream?after=`, { headers: { cookie }, signal: abort.signal });
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("seen on another tab")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += new TextDecoder().decode(chunk.value);
    }
    abort.abort();
    expect(seen).toContain("event: queued");
    expect(seen).toContain("seen on another tab");
    await clear();
  });

  test("ssh talk /queue, /queued, /unqueue and /steer", async () => {
    expect(parseDuring("/queue hello there")).toEqual({ during: "queue", words: "hello there" });
    expect(parseDuring("/steer now")).toEqual({ during: "interrupt", words: "now" });
    expect(parseDuring("plain words")).toBeUndefined();
    await start();
    const queued = await exec("talk /queue later please");
    expect(queued.code).toBe(0);
    expect(queued.out).toContain("queued");
    const id = /talk \/unqueue (\S+)\)/.exec(queued.out)![1]!;
    expect((await exec("talk /queued")).out).toContain(`${id}  later please`);
    expect((await exec(`talk /unqueue ${id}`)).out).toContain("cancelled");
    expect((await exec(`talk /unqueue ${id}`)).code).toBe(1);
    expect((await exec("talk /queued")).out).toContain("nothing is waiting");
    expect((await exec("talk /steer instead")).out).toContain("stopped the answer");
    await clear();
  });
});

describe("the turns carry an ETag (#9278)", () => {
  const read = (extra: Record<string, string> = {}, query = "") =>
    fetch(`${servers.url}/api/v1/conversation/turns${query}`, { headers: { authorization: `Bearer ${rw}`, ...extra } });

  test("a repeat is a bodiless 304; a queued or cancelled message and a run starting or ending change the tag", async () => {
    const first = await read();
    expect(first.status).toBe(200);
    await first.text();
    const idle = first.headers.get("etag")!;
    expect(idle).toMatch(/^W\//);
    expect(first.headers.get("cache-control")).toBe("private");
    const again = await read({ "if-none-match": idle });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(idle);
    expect(again.headers.get("cache-control")).toBe("private");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("referrer-policy")).toBeTruthy();
    expect(again.headers.get("content-security-policy")).toBeTruthy();

    await start();
    const running = await read({ "if-none-match": idle });
    expect(running.status).toBe(200);
    await running.text();
    const runTag = running.headers.get("etag")!;
    expect(runTag).not.toBe(idle);
    expect((await read({ "if-none-match": runTag })).status).toBe(304);

    const queued = (await (await send({ text: "later", during: "queue" })).json()) as { queued: string };
    const waiting = await read({ "if-none-match": runTag });
    expect(waiting.status).toBe(200);
    await waiting.text();
    const waitTag = waiting.headers.get("etag")!;
    expect(waitTag).not.toBe(runTag);

    const del = await fetch(`${servers.url}/api/v1/conversation/queue/${queued.queued}`, { method: "DELETE", headers: headers(rw) });
    expect(del.status).toBe(200);
    const cancelled = await read({ "if-none-match": waitTag });
    expect(cancelled.status).toBe(200);
    await cancelled.text();
    expect(cancelled.headers.get("etag")).toBe(runTag);

    await clear();
    const ended = await read({ "if-none-match": runTag });
    expect(ended.status).toBe(200);
    await ended.text();
    expect(ended.headers.get("etag")).not.toBe(runTag);
  });

  test("`limit` and `before` give different tags, and a tag from another person's read never matches", async () => {
    const a = await read({}, "");
    await a.text();
    const b = await read({}, "?limit=1");
    await b.text();
    expect(b.headers.get("etag")).not.toBe(a.headers.get("etag"));
    const other = await fetch(`${servers.url}/api/v1/conversation/turns`, { headers: { authorization: `Bearer ${bob}`, "if-none-match": a.headers.get("etag")! } });
    expect(other.status).toBe(200);
  });
});
