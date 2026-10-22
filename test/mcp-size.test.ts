/**
 * Every harness session pays for `tools/list` before it does anything, so
 * the answer has a ceiling: past it, the longest descriptions are named so
 * the next cut is obvious.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const CEILING = 40_000;
// Headroom: a new tool should fit without another round of cuts.
const HEADROOM_CEILING = 37_000;

let dataDir: string;
let app: App;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-size-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  // The first user is a forge admin, who is listed every tool: the largest answer.
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  token = createToken(app.db, made.value.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("tools/list stays under 40 KB, with 3 KB of headroom (37,000 bytes)", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await res.text();
  const bytes = Buffer.byteLength(text);
  const tools = (JSON.parse(text) as any).result.tools as {
    name: string;
    description: string;
    annotations?: { readOnlyHint?: boolean };
  }[];
  // readOnlyHint defaults to false; spelling the default out on every write
  // tool cost 2 KB, so only a read tool carries annotations.
  expect(tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name)).toEqual([]);
  const longest = tools
    .map((t) => `${t.name} (${Buffer.byteLength(t.description)} bytes)`)
    .sort(
      (a, b) =>
        Number(/\((\d+) /.exec(b)![1]) - Number(/\((\d+) /.exec(a)![1]),
    )
    .slice(0, 5);
  expect(
    bytes,
    `tools/list is ${bytes} bytes, over ${CEILING}; the five longest descriptions: ${longest.join(", ")}`,
  ).toBeLessThanOrEqual(CEILING);
  expect(
    bytes,
    `tools/list is ${bytes} bytes, over the ${HEADROOM_CEILING} headroom; the five longest descriptions: ${longest.join(", ")}`,
  ).toBeLessThanOrEqual(HEADROOM_CEILING);
});
