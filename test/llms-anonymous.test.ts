/** A stranger's /llms.txt folds the MCP tool list to what they can call. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-llms-anon-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
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

const section = (body: string): string[] => {
  const lines = body.split("\n");
  const start = lines.indexOf("## MCP tools");
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end).filter((l) => l.startsWith("- "));
};

test("the anonymous text is small, varies by reader, and lists report and start plus one line", async () => {
  const res = await fetch(`${servers.url}/llms.txt`);
  const body = await res.text();
  // 6.5 KiB until the three doors (#12015, about 440 bytes) opened the text;
  // nothing else was cut to make room.
  expect(Buffer.byteLength(body)).toBeLessThan(7 * 1024);
  expect(res.headers.get("vary")).toContain("Cookie");
  expect(res.headers.get("vary")).toContain("Authorization");
  const listed = section(body);
  expect(listed).toHaveLength(3);
  expect(listed[0]).toStartWith("- report: ");
  expect(listed[1]).toStartWith("- start: ");
  expect(listed[2]).toContain(`${TOOLS.length} more tools with an account`);
  expect(listed[2]).toContain("tools/list");
  expect(listed[2]).toContain("/contract/openapi.json");
});

test("every tool the anonymous text names is one tools/list returns", async () => {
  const names = section(await fetch(`${servers.url}/llms.txt`).then((r) => r.text()))
    .map((l) => /^- ([a-z_]+): /.exec(l)?.[1])
    .filter((n): n is string => n !== undefined);
  expect(names).toEqual(["report", "start"]);
  const returned: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) }),
    }).then((r) => r.json() as Promise<any>);
    returned.push(...list.result.tools.map((t: { name: string }) => t.name));
    cursor = list.result.nextCursor;
  } while (cursor !== undefined);
  for (const n of names) expect(returned).toContain(n);
});

test("a signed-in reader still gets every tool and report", async () => {
  const body = await fetch(`${servers.url}/llms.txt`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.text());
  expect(section(body)).toHaveLength(TOOLS.length + 2);
});

test("the OpenAPI line names ?tag= and the tags", async () => {
  const body = await (await fetch(`${servers.url}/llms.txt`)).text();
  const line = body.split("\n").find((l) => l.startsWith("- OpenAPI:")) ?? "";
  expect(line).toContain("?tag=");
  expect(line).toContain("pulls");
});
