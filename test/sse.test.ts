import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

/** Read from an SSE body until `predicate(buffer)` holds or we time out. */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  predicate: (buf: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(
          () => r({ done: true, value: undefined }),
          Math.max(0, deadline - Date.now()),
        ),
      );
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      if (predicate(buf)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return buf;
}

describe("SSE live event stream", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  const form = (f: Record<string, string>) => new URLSearchParams(f);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sse-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, {
      username: "sse",
      email: "sse@f.dev",
      password: "live-updates-now",
    });
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ name: "proj", visibility: "public" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("opens an event-stream with the right content type", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/sse/proj/stream`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  test("a connected client receives an event appended afterwards", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/sse/proj/stream`, {
      signal: controller.signal,
    });
    const repoId = app.db
      .query<{ id: string }, []>("SELECT id FROM repo LIMIT 1")
      .get()!.id;

    // The connection (and thus the bus subscription) is live now; fire an event.
    app.bus.append({ kind: "issue.opened", repoId, payload: { number: 7 } });

    const buf = await readUntil(res.body!, (b) =>
      b.includes("event: issue.opened"),
    );
    expect(buf).toContain("event: issue.opened");
    expect(buf).toContain('"number":7');
    controller.abort();
  });

  test("does not leak events from other repos", async () => {
    // A second repo; events on it must not appear on proj's stream.
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ name: "other", visibility: "public" }),
      redirect: "manual",
    });
    const rows = app.db
      .query<{ id: string; name: string }, []>("SELECT id, name FROM repo")
      .all();
    const otherId = rows.find((r) => r.name === "other")!.id;

    const controller = new AbortController();
    const res = await fetch(`${base}/sse/proj/stream`, {
      signal: controller.signal,
    });
    app.bus.append({ kind: "push", repoId: otherId, payload: { ref: "main" } });
    // Give it a moment; proj's stream should only carry the heartbeat/connect.
    const buf = await readUntil(res.body!, () => false, 400);
    expect(buf).not.toContain("event: push");
    controller.abort();
  });

  test("a private repo's stream is hidden from strangers", async () => {
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ name: "secret", visibility: "private" }),
      redirect: "manual",
    });
    const anon = await fetch(`${base}/sse/secret/stream`);
    expect(anon.status).toBe(404);
    await anon.body?.cancel();
    const owner = await fetch(`${base}/sse/secret/stream`, {
      headers: { cookie },
    });
    expect(owner.status).toBe(200);
    await owner.body?.cancel();
  });
});
