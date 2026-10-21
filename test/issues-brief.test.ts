import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("issues list ?fields=brief", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";

  const send = (path: string, method = "GET", bodyObj?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(bodyObj === undefined ? {} : { body: JSON.stringify(bodyObj) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-brief-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, { username: "dev", email: "d@f.dev", password: "brief-pass-1" });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "dev",
        password: "brief-pass-1",
        name: "c",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await send("/api/v1/repos", "POST", { name: "lib", visibility: "public" });
    const body = "A long description of the problem. ".repeat(40);
    for (let i = 0; i < 50; i++)
      await send("/api/v1/repos/dev/lib/issues", "POST", { title: `Issue ${i}`, body });
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("brief drops bodies and is under a fifth of the bytes", async () => {
    const path = "/api/v1/repos/dev/lib/issues?limit=50";
    const full = await (await send(path)).text();
    const briefRes = await send(`${path}&fields=brief`);
    expect(briefRes.status).toBe(200);
    const brief = await briefRes.text();
    const items = (JSON.parse(brief) as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(50);
    expect(JSON.parse(full).items[0].body).toBeString();
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "assignee", "author", "authorIsAgent", "createdAt", "kind", "labels",
          "number", "originAuthor", "state", "title", "updatedAt",
        ].sort(),
      );
    }
    expect(brief.length).toBeLessThan(full.length / 5);
  });

  test("any other fields value is a 422", async () => {
    for (const v of ["full", "", "brief,body"]) {
      const res = await send(`/api/v1/repos/dev/lib/issues?fields=${v}`);
      expect(res.status).toBe(422);
    }
  });
});
