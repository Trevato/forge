/**
 * Every harness session pays for `tools/list` before it does anything, so
 * the answer has a ceiling: past it, the longest descriptions are named so
 * the next cut is obvious.
 *
 * Measure locally with `bun test test/mcp-size.test.ts`. A failure says how
 * many bytes the answer is, how many it is over, and the longest
 * descriptions. Before adding a tool, extend an existing one with an
 * `action` or `kind` (docs/MCP.md, "Room for a new tool"). The ceilings are
 * the owner's: do not raise them in a feature pull.
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
// #4990 raised it to 37,500 to fit `threads`; the tool descriptions were cut
// instead (#5105), so it is 37,000 again: raising it is how the lane went red.
const HEADROOM_CEILING = 37_000;
// One sentence a tool: past this, a description is a paragraph and belongs in
// docs/MCP.md, which keeps the detail.
const DESCRIPTION_CEILING = 120;
// No argument description is longer than this.
const PROPERTY_MAX = 60;

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
    inputSchema: unknown;
    annotations?: { readOnlyHint?: boolean };
  }[];
  // The argument words are short; the detail lives in docs/MCP.md.
  const long: string[] = [];
  const walk = (tool: string, node: any, path: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries<any>(node.properties ?? {})) {
      if (typeof v?.description === "string" && Buffer.byteLength(v.description) > PROPERTY_MAX)
        long.push(`${tool}.${path}${k} (${Buffer.byteLength(v.description)} bytes)`);
      walk(tool, v, `${path}${k}.`);
    }
    walk(tool, node.items, path);
  };
  for (const t of tools) walk(t.name, t.inputSchema, "");
  expect(long, `property descriptions over ${PROPERTY_MAX} bytes`).toEqual([]);
  expect(bytes, "the argument descriptions were cut by 1,000 bytes").toBeLessThanOrEqual(
    36_700,
  );
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
    `tools/list is ${bytes} bytes, ${bytes - CEILING} over the ${CEILING} ceiling; the five longest descriptions: ${longest.join(", ")}`,
  ).toBeLessThanOrEqual(CEILING);
  expect(
    bytes,
    `tools/list is ${bytes} bytes, ${bytes - HEADROOM_CEILING} over the ${HEADROOM_CEILING} headroom (${CEILING - bytes} left under the ceiling); the five longest descriptions: ${longest.join(", ")}`,
  ).toBeLessThanOrEqual(HEADROOM_CEILING);
  expect(
    tools
      .filter((t) => Buffer.byteLength(t.description) > DESCRIPTION_CEILING)
      .map((t) => `${t.name} (${Buffer.byteLength(t.description)} bytes)`),
    `tool descriptions over ${DESCRIPTION_CEILING} bytes`,
  ).toEqual([]);
});
