import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("labels ETag", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";
  const send = (path: string, method = "GET", bodyObj?: unknown, headers: Record<string, string> = {}, auth = true) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...headers,
      },
      ...(bodyObj === undefined ? {} : { body: JSON.stringify(bodyObj) }),
    });
  const L = "/api/v1/repos/dev/lib/labels";
  const I = "/api/v1/repos/dev/lib/issues";
  const tagOf = async (auth = true) => (await send(L, "GET", undefined, {}, auth)).headers.get("etag")!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-labels-etag-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, { username: "dev", email: "d@f.dev", password: "etag-pass-1" });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true, username: "dev", password: "etag-pass-1", name: "c", scope: "admin" }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await send("/api/v1/repos", "POST", { name: "lib", visibility: "public" });
    await send(L, "POST", { name: "bug", color: "d73a4a" });
    await send(I, "POST", { title: "One", body: "b" });
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("200 with headers, then 304 on a repeat with the floor headers", async () => {
    const first = await send(L);
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\//);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("authorization, cookie");
    await first.text();
    const again = await send(L, "GET", undefined, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await again.text()).toBe("");
  });

  test("add, rename, remove, and an issue opening or closing move the tag", async () => {
    let tag = await tagOf();
    const moved = async (what: string) => {
      const r = await send(L, "GET", undefined, { "if-none-match": tag });
      expect(r.status, what).toBe(200);
      const next = r.headers.get("etag")!;
      expect(next, what).not.toBe(tag);
      tag = next;
    };
    const made = await send(L, "POST", { name: "docs", color: "0075ca" });
    const id = ((await made.json()) as { id: string }).id;
    await moved("add");
    expect((await send(`${L}/${id}`, "PATCH", { name: "documentation" })).status).toBe(200);
    await moved("rename");
    await send(`${I}/1/labels`, "PUT", { labels: ["bug"] });
    await moved("label an issue");
    await send(`${I}/1`, "PATCH", { state: "closed", note: "done" });
    await moved("close");
    await send(`${I}/1`, "PATCH", { state: "open" });
    await moved("reopen");
    expect((await send(`${L}/${id}`, "DELETE")).status).toBe(204);
    await moved("remove");
  });

  test("a writer's tag never matches a reader's body once a sealed issue differs their counts", async () => {
    await send(I, "POST", { title: "Hidden", body: "x", sealed: true });
    await send(`${I}/2/labels`, "PUT", { labels: ["bug"] });
    const writer = await tagOf();
    const reader = await tagOf(false);
    expect(writer).not.toBe(reader);
    const out = await send(L, "GET", undefined, { "if-none-match": writer }, false);
    expect(out.status).toBe(200);
  });

  test("a 404 or a bad page parameter carries no tag", async () => {
    const missing = await send("/api/v1/repos/dev/nope/labels");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("etag")).toBeNull();
    const bad = await send(`${L}?limit=abc`);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.headers.get("etag")).toBeNull();
  });
});
