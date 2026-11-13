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
import { withScripts } from "./helpers/page-script.ts";

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
    expect(await withScripts(servers.url, body)).toContain("new EventSource('/system/stream')");
    // First paint is server-rendered with the latest sample.
    expect(body).toContain('id="summary"');
    expect(body).toMatch(/id="summary"[^>]*>\s*<[^>]*>CPU /);
    // The process table is marked to keep the reader's place across a swap.
    const { Window } = await import("happy-dom");
    const doc = new Window().document;
    doc.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");
    expect(doc.getElementById("sys-procs")?.hasAttribute("data-live-hold")).toBe(true);
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
    if (!text.includes("98765")) throw new Error(`never came: still waiting while !text.includes("98765")`);
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
    expect(stream.status).toBe(403);
    expect(stream.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    await stream.body?.cancel();
  });

  test("the sampler's clock runs only while someone watches, and ticks while they do", async () => {
    // A hand-cranked clock: no sleeping, so a loaded machine cannot starve it.
    let tick: (() => void) | undefined;
    let cancelled = 0;
    const own = createLive({
      schedule: (fn) => {
        tick = fn;
        return () => {
          tick = undefined;
          cancelled++;
        };
      },
    });
    expect(own.running()).toBe(false);
    const first = own.subscribe(() => {});
    expect(own.running()).toBe(true);
    first();
    expect(own.running()).toBe(false);
    expect(cancelled).toBe(1);
    let ticks = 0;
    const second = own.subscribe(() => ticks++);
    expect(own.running()).toBe(true);
    for (let i = 0; i < 3; i++) tick!();
    expect(ticks).toBe(3);
    second();
    expect(tick).toBeUndefined();
    expect(cancelled).toBe(2);
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

describe("/system's process table holds the reader's place", () => {
  const table = (rows: [string, number][]) =>
    `<div class="table-scroll"><table><tbody data-kind="app" data-cpu="1" data-mem="1"><tr data-group><th>apps</th></tr>` +
    rows.map(([pid, cpu]) => `<tr data-cpu="${cpu}" data-mem="1"><td>${pid}</td><td><a href="#${pid}">cmd ${pid}</a></td></tr>`).join("") +
    `</tbody></table></div>`;

  /** The page script run against a DOM; `push` delivers one sample to its stream listener. */
  async function open(hold: boolean) {
    const { Window } = await import("happy-dom");
    const { systemLiveJs } = await import("../src/web/system-live.ts");
    const win = new Window();
    const doc = win.document;
    // happy-dom has no `rows` on a table section; the page script reads it.
    const section = (doc.createElement("tbody") as unknown as { constructor: { prototype: object } }).constructor.prototype;
    Object.defineProperty(section, "rows", { configurable: true, get(this: { querySelectorAll(s: string): unknown }) { return this.querySelectorAll(":scope > tr"); } });
    doc.body.innerHTML = `<div id="sys-procs"${hold ? " data-live-hold" : ""}>${table([["10", 5], ["20", 1]])}</div><div id="summary">old</div>`;
    let listener: (e: { data: string }) => void = () => {};
    class FakeSource {
      addEventListener(_: string, fn: typeof listener) { listener = fn; }
    }
    new Function("document", "EventSource", "location", systemLiveJs)(doc, FakeSource, { search: "" });
    const push = (regions: Record<string, string>) => listener({ data: JSON.stringify({ regions }) });
    return { doc, push };
  }

  test("the stream's payload names the held region", async () => {
    const { regions } = await import("../src/web/pages/system.ts");
    expect(Object.keys(regions(createLive().read()))).toContain("sys-procs");
  });

  test("focus on a row that left falls back to the same control in its group, not to the page", async () => {
    const { doc, push } = await open(true);
    (doc.querySelector('a[href="#20"]') as unknown as { focus(): void }).focus();
    // pid 20's process ended: its row is gone from the next sample.
    push({ "sys-procs": table([["10", 5], ["30", 1]]) });
    expect(doc.activeElement?.getAttribute("href")).toBe("#10");
  });

  test("a held region keeps its scroll and its focus (after the re-sort) while only it and named regions change", async () => {
    const { doc, push } = await open(true);
    const box = doc.querySelector("#sys-procs .table-scroll")!;
    box.scrollTop = 40;
    box.scrollLeft = 25;
    (doc.querySelector('a[href="#20"]') as unknown as { focus(): void }).focus();
    // pid 20 now has the most CPU, so sort() moves its row above pid 10's.
    push({ "sys-procs": table([["10", 1], ["20", 9]]), summary: "new" });
    const rows = [...doc.querySelectorAll("#sys-procs tr[data-cpu]")].map((r) => r.getAttribute("data-cpu"));
    expect(rows).toEqual(["9", "1"]);
    const after = doc.querySelector("#sys-procs .table-scroll")!;
    expect(after).not.toBe(box);
    expect(after.scrollTop).toBe(40);
    expect(after.scrollLeft).toBe(25);
    expect(doc.activeElement?.getAttribute("href")).toBe("#20");
    expect(doc.getElementById("summary")!.innerHTML).toBe("new");
  });

  test("a region without the marker is replaced as before: no scroll, no focus kept", async () => {
    const { doc, push } = await open(false);
    doc.querySelector("#sys-procs .table-scroll")!.scrollTop = 40;
    (doc.querySelector('a[href="#20"]') as unknown as { focus(): void }).focus();
    push({ "sys-procs": table([["10", 1], ["20", 9]]) });
    expect(doc.querySelector("#sys-procs .table-scroll")!.scrollTop).toBe(0);
    expect(doc.activeElement?.getAttribute("href")).not.toBe("#20");
  });
});
