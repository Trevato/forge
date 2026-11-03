import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("issues list ETag", () => {
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
  const LIST = "/api/v1/repos/dev/lib/issues";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-issues-etag-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, { username: "dev", email: "d@f.dev", password: "etag-pass-1" });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true, username: "dev", password: "etag-pass-1", name: "c", scope: "rw" }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await send("/api/v1/repos", "POST", { name: "lib", visibility: "public" });
    await send(LIST, "POST", { title: "First", body: "b" });
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("200, then 304 on a repeat, then 200 with a new tag after a change", async () => {
    const first = await send(LIST);
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\//);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("authorization, cookie");
    await first.text();

    const again = await send(LIST, "GET", undefined, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(await again.text()).toBe("");

    await send(LIST, "POST", { title: "Second", body: "b" });
    const changed = await send(LIST, "GET", undefined, { "if-none-match": tag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
    expect(((await changed.json()) as { items: unknown[] }).items.length).toBe(2);
  });

  test("fields=brief and limit tag their own page", async () => {
    const full = (await send(LIST)).headers.get("etag");
    const brief = (await send(`${LIST}?fields=brief`)).headers.get("etag");
    const one = (await send(`${LIST}?limit=1`)).headers.get("etag");
    expect(new Set([full, brief, one]).size).toBe(3);
  });

  test("a signed-out reader and a writer who sees a sealed issue get different tags", async () => {
    const before = (await send(LIST, "GET", undefined, {}, false)).headers.get("etag");
    await send(LIST, "POST", { title: "Sealed", body: "x", sealed: true });
    const out = await send(LIST, "GET", undefined, {}, false);
    const writer = await send(LIST);
    expect(out.headers.get("etag")).toBe(before!);
    expect(writer.headers.get("etag")).not.toBe(out.headers.get("etag"));
  });
});

describe("issue comments ETag", () => {
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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-comments-etag-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, { username: "dev", email: "d@f.dev", password: "etag-pass-1" });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true, username: "dev", password: "etag-pass-1", name: "c", scope: "rw" }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await send("/api/v1/repos", "POST", { name: "lib", visibility: "public" });
    await send("/api/v1/repos/dev/lib/issues", "POST", { title: "T", body: "b" });
    await send("/api/v1/repos/dev/lib/issues", "POST", { title: "Hidden", body: "x", sealed: true });
    await send("/api/v1/repos/dev/lib/issues/1/comments", "POST", { body: "one" });
    await send("/api/v1/repos/dev/lib/issues/2/comments", "POST", { body: "secret" });
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("200, 304, then 200 with a new tag after a comment", async () => {
    const path = "/api/v1/repos/dev/lib/issues/1/comments";
    const first = await send(path);
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\//);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("authorization, cookie");
    await first.text();
    const again = await send(path, "GET", undefined, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(await again.text()).toBe("");
    await send(path, "POST", { body: "two" });
    const changed = await send(path, "GET", undefined, { "if-none-match": tag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
    const cursorTag = (await send(`${path}?limit=1`)).headers.get("etag");
    expect(cursorTag).not.toBe(changed.headers.get("etag"));
  });

  test("a stranger is refused a sealed thread whatever tag they hold", async () => {
    const path = "/api/v1/repos/dev/lib/issues/2/comments";
    const own = (await send(path)).headers.get("etag")!;
    const out = await send(path, "GET", undefined, { "if-none-match": own }, false);
    expect(out.status).not.toBe(304);
    expect(out.status).not.toBe(200);
    const star = await send(path, "GET", undefined, { "if-none-match": "*" }, false);
    expect(star.status).not.toBe(304);
    expect(star.status).not.toBe(200);
  });
});
