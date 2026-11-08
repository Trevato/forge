import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("builds list ETag", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";

  const send = (path: string, method = "GET", bodyObj?: unknown, headers: Record<string, string> = {}, auth = true) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers },
      ...(bodyObj === undefined ? {} : { body: JSON.stringify(bodyObj) }),
    });
  const LIST = "/api/v1/repos/dev/lib/builds";
  const commit = async (repo: string, message: string) => {
    const r = await send(`/api/v1/repos/dev/${repo}/contents`, "POST", { branch: "main", message, files: [{ path: `${message}.txt`, content: "x\n" }] });
    return ((await r.json()) as { commitOid?: string; oid?: string; sha?: string }) ;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-builds-etag-"));
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
    await send("/api/v1/repos", "POST", { name: "secret", visibility: "private" });
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("200, 304 on a repeat, 200 with a new tag after a pin", async () => {
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

    const c = await commit("lib", "one");
    const sha = c.commitOid ?? c.oid ?? c.sha;
    expect(typeof sha).toBe("string");
    const pinned = await send(LIST, "POST", { label: "v1", sha });
    expect(pinned.status).toBe(201);

    const changed = await send(LIST, "GET", undefined, { "if-none-match": tag });
    expect(changed.status).toBe(200);
    const newTag = changed.headers.get("etag")!;
    expect(newTag).not.toBe(tag);
    expect(((await changed.json()) as { items: unknown[] }).items.length).toBe(1);

    await send(`${LIST}/v1`, "PATCH", { note: "hello" });
    const noted = await send(LIST, "GET", undefined, { "if-none-match": newTag });
    expect(noted.status).toBe(200);
    expect(noted.headers.get("etag")).not.toBe(newTag);
  });

  test("a private repository is a 404 to a stranger holding any tag", async () => {
    const r = await send("/api/v1/repos/dev/secret/builds", "GET", undefined, { "if-none-match": "*" }, false);
    expect(r.status).toBe(404);
    expect(r.headers.get("etag")).toBeNull();
  });
});
