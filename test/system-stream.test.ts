/**
 * /system is live over one event stream (#2720): its HTML never reloads or
 * polls, and a sample handed to the sampler arrives on the stream.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { eventStream, sseDroppedCount } from "../src/http/sse.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createLive, useLive } from "../src/system/live.ts";

describe("/system over server-sent events", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;
  const sampler = createLive({ pushMs: 20 });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sysstream-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
    });
    useLive(sampler);
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });

  afterAll(async () => {
    useLive(createLive());
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the page has no refresh and no interval reload, and opens the stream", async () => {
    const res = await fetch(`${servers.url}/system`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toMatch(/http-equiv=["']?refresh/i);
    expect(body).not.toContain("location.reload");
    expect(body).not.toContain("setTimeout");
    expect(body).not.toContain("setInterval");
    expect(body).toContain("new EventSource('/system/stream')");
    // First paint is server-rendered with the latest sample.
    expect(body).toContain('id="summary"');
    expect(body).toMatch(/id="summary"[^>]*>\s*<[^>]*>CPU /);
  });

  test("a sample written to the sampler arrives on the stream; a stranger is refused", async () => {
    const anon = await fetch(`${servers.url}/system/stream`, { redirect: "manual" });
    expect(anon.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    await anon.body?.cancel();
    const res = await fetch(`${servers.url}/system/stream`, { headers: { cookie } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const base = sampler.read();
    sampler.publish({ ...base, processes: 98765 });
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes("98765") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain("event: sample");
    expect(text).toContain("98765 processes");
  });

  test("a signed-in non-owner is refused the stream as the page is", async () => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
    });
    const bob = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(bob).not.toBe("");
    const stream = await fetch(`${servers.url}/system/stream`, { headers: { cookie: bob } });
    expect(stream.status).toBe(404);
    expect(stream.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    await stream.body?.cancel();
  });

  test("the sampler's clock runs only while someone watches, and ticks while they do", async () => {
    const own = createLive({ pushMs: 10 });
    expect(own.running()).toBe(false);
    const first = own.subscribe(() => {});
    expect(own.running()).toBe(true);
    first();
    expect(own.running()).toBe(false);
    let ticks = 0;
    const second = own.subscribe(() => ticks++);
    expect(own.running()).toBe(true);
    await Bun.sleep(100);
    second();
    expect(ticks).toBeGreaterThan(2);
    const stopped = ticks;
    await Bun.sleep(60);
    expect(ticks).toBe(stopped);
    expect(own.running()).toBe(false);
  });

  test("a reader that never reads stops being queued to once half full, and is not dropped", async () => {
    let emitter: ((e: string, d: unknown) => void) | undefined;
    let ready: (() => boolean) | undefined;
    let closed = false;
    const res = eventStream({} as App, new Request("http://x/s"), (emit, _close, r) => {
      emitter = emit;
      ready = r;
      return () => {
        closed = true;
      };
    });
    const dropped = sseDroppedCount();
    const frame = "x".repeat(8 * 1024);
    let sent = 0;
    while (ready!() && sent < 1000) {
      emitter!("sample", frame);
      sent++;
    }
    // Gated: it stopped well short of the 256 KB budget (about 16 frames), without a drop.
    expect(sent).toBeGreaterThan(5);
    expect(sent).toBeLessThan(25);
    expect(ready!()).toBe(false);
    expect(closed).toBe(false);
    expect(sseDroppedCount()).toBe(dropped);
    // Reading frees room again.
    const reader = res.body!.getReader();
    for (let i = 0; i < sent && !ready!(); i++) await reader.read();
    expect(ready!()).toBe(true);
    await reader.cancel();
  });
});
