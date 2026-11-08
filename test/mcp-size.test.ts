/**
 * Every harness session pays for `tools/list` before it does anything, so
 * the answer has a ceiling: past it, the longest descriptions are named so
 * the next cut is obvious.
 *
 * Measure locally with `bun test test/mcp-size.test.ts`. A failure says how
 * many bytes the answer is, how many it is over, and the five costliest
 * tools. Before adding a tool, extend an existing one with an
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
import { costliestTools } from "./mcp-size-rank.ts";
import { serve, type Servers } from "../src/http/server.ts";

const CEILING = 40_000;
// Headroom: a new tool should fit without another round of cuts.
// #4990 raised it to 37,500 to fit `threads`; the tool descriptions were cut
// instead (#5105), so it is 37,000 again: raising it is how the lane went red.
// #5433 raised it to 37,150 for `restore_drill` (124 bytes; main had 3 spare).
// At 36,741 bytes with 259 left, every pull adding a tool went red (#6013);
// `dryRun`'s 17 descriptions moved to the instructions and the longest tool
// descriptions were cut, so it is back at 37,000 with room for the next tool.
// #6217: pulls that each add a tool clashed: the first to land passed and the
// rest went red. Measured on 13 open pulls adding a tool (head minus its merge
// base): 7 to 201 bytes each, 1,350 in all, about 104 apiece; the two that
// measured 0 are budgeted at 200 each. 1,750 needed. `front_page` dropped
// 76 bytes of range the server already enforces, and this pull proposes 38,500
// (the owner confirms): 1,500 under the hard ceiling, ~1,800 of room today.
// Past it, trim the costliest tools the failure names; do not raise.
const HEADROOM_CEILING = 38_500;
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

async function page(cursor?: unknown): Promise<{ text: string; json: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      ...(cursor === undefined ? {} : { params: { cursor } }),
    }),
  });
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

/** Every page, in order: each page's bytes and all the tools. */
async function walk(): Promise<{ sizes: number[]; tools: any[] }> {
  const sizes: number[] = [];
  const tools: any[] = [];
  let cursor: string | undefined;
  do {
    const { text, json } = await page(cursor);
    sizes.push(Buffer.byteLength(text));
    tools.push(...json.result.tools);
    cursor = json.result.nextCursor;
  } while (cursor !== undefined);
  return { sizes, tools };
}

test(`each page of tools/list stays under 40 KB, with 1.5 KB of headroom (${HEADROOM_CEILING.toLocaleString("en-US")} bytes)`, async () => {
  const { sizes, tools } = await walk();
  const bytes = Math.max(...sizes);
  expect(sizes.length).toBeGreaterThan(1);
  // The argument words are short; the detail lives in docs/MCP.md.
  const long: string[] = [];
  const walkProps = (tool: string, node: any, path: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries<any>(node.properties ?? {})) {
      if (typeof v?.description === "string" && Buffer.byteLength(v.description) > PROPERTY_MAX)
        long.push(`${tool}.${path}${k} (${Buffer.byteLength(v.description)} bytes)`);
      walkProps(tool, v, `${path}${k}.`);
    }
    walkProps(tool, node.items, path);
  };
  for (const t of tools) walkProps(t.name, t.inputSchema, "");
  expect(long, `property descriptions over ${PROPERTY_MAX} bytes`).toEqual([]);
  // readOnlyHint defaults to false; spelling the default out on every write
  // tool cost 2 KB, so only a read tool carries annotations.
  expect(tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name)).toEqual([]);
  const longest = costliestTools(tools);
  expect(
    bytes,
    `a tools/list page is ${bytes} bytes, ${bytes - CEILING} over the ${CEILING} ceiling; the five costliest tools: ${longest}`,
  ).toBeLessThanOrEqual(CEILING);
  expect(
    bytes,
    `a tools/list page is ${bytes} bytes, ${bytes - HEADROOM_CEILING} over the ${HEADROOM_CEILING} headroom (${CEILING - bytes} left under the ceiling); the five costliest tools: ${longest}`,
  ).toBeLessThanOrEqual(HEADROOM_CEILING);
  expect(
    tools
      .filter((t) => Buffer.byteLength(t.description) > DESCRIPTION_CEILING)
      .map((t) => `${t.name} (${Buffer.byteLength(t.description)} bytes)`),
    `tool descriptions over ${DESCRIPTION_CEILING} bytes`,
  ).toEqual([]);
});

test("`dryRun` is explained once, in the instructions, not on every tool", async () => {
  const call = async (method: string) =>
    (await (
      await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: { protocolVersion: "2025-06-18" },
        }),
      })
    ).json()) as any;
  const tools = (await walk()).tools as {
    name: string;
    inputSchema: { properties?: Record<string, { description?: string }> };
  }[];
  const planners = tools.filter((t) => t.inputSchema.properties?.dryRun);
  expect(planners.length).toBeGreaterThan(10);
  // Seventeen copies of "false to apply" were 527 bytes of tools/list.
  expect(
    planners.filter((t) => t.inputSchema.properties!.dryRun!.description).map((t) => t.name),
  ).toEqual([]);
  expect((await call("initialize")).result.instructions).toContain(
    "A tool with `dryRun` plans unless it is `false`.",
  );
});

test("walking every page lists every tool exactly once", async () => {
  const { tools } = await walk();
  const names = tools.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toContain("report");
  const first = await page();
  expect(first.json.result.nextCursor).toBe(first.json.result.tools.at(-1).name);
});

test("a cursor that names no tool is an invalid-params error", async () => {
  for (const bad of ["nope", "", 7]) {
    const { json } = await page(bad);
    expect(json.error.code).toBe(-32602);
    expect(json.result).toBeUndefined();
  }
});
