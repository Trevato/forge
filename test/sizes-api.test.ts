/** The sizes answer is the table in src/spawn/sizes.ts, over HTTP and over MCP. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { SIZES, sizesView, type Size } from "../src/spawn/sizes.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("forge sizes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sizes-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    token = createToken(app.db, u.value.id, "t", "ro").token;
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("signed out, each size answers its table row and a sentence", async () => {
    const res = await fetch(`${servers.url}/api/v1/forges/sizes`);
    expect(res.status).toBe(200);
    const got = (await res.json()) as ReturnType<typeof sizesView>;
    expect(got).toEqual(sizesView());
    expect(got.sizes.map((s) => s.size)).toEqual(Object.keys(SIZES) as Size[]);
    for (const s of got.sizes) {
      const row = SIZES[s.size];
      expect([s.cpu, s.memoryMiB, s.diskMiB]).toEqual([row.cpu, row.memoryMiB, row.diskMiB]);
      expect(s.says.length).toBeGreaterThan(10);
      // Figures live only in the fields, so a changed row cannot leave a sentence behind.
      expect(s.says).not.toMatch(/\d|\b(one|two|three|four|eight|half|quarter)\b|\b[kmgt]b\b|gigabyte|megabyte|cpus?\b/i);
    }
  });

  test("it carries an ETag and answers 304 to it", async () => {
    const first = await fetch(`${servers.url}/api/v1/forges/sizes`);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await fetch(`${servers.url}/api/v1/forges/sizes`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  test("the MCP tool returns the same JSON", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "sizes", arguments: {} },
      }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual(sizesView());
  });
});
