/** Every `limit` in the served OpenAPI document states its bounds, and the routes keep to them (#9087). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
type Param = { name: string; in: string; schema: { type: string; minimum?: number; maximum?: number } };
let doc: { paths: Record<string, Record<string, { parameters: Param[] }>> };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-openapi-limit-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  doc = (await (await fetch(`${servers.url}/contract/openapi.json`)).json()) as typeof doc;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const limits = () =>
  Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.entries(ops).flatMap(([method, op]) =>
      op.parameters.filter((p) => p.in === "query" && p.name === "limit").map((p) => ({ at: `${method.toUpperCase()} ${path}`, schema: p.schema })),
    ),
  );

test("every limit parameter in the served document is an integer with both bounds", () => {
  const all = limits();
  expect(all.length).toBeGreaterThanOrEqual(28);
  const bad = all.filter(({ schema }) => schema.type !== "integer" || schema.minimum !== 1 || !Number.isInteger(schema.maximum) || schema.maximum! < 1);
  expect(bad.map((b) => b.at)).toEqual([]);
});

for (const path of ["/api/v1/search", "/api/v1/repos"]) {
  test(`${path} answers at the documented maximum and refuses one past it`, async () => {
    const max = doc.paths[path]!["get"]!.parameters.find((p) => p.name === "limit")!.schema.maximum!;
    expect(max).toBeGreaterThan(0);
    const at = await fetch(`${servers.url}${path}?q=x&limit=${max}`);
    expect(at.status).toBe(200);
    const past = await fetch(`${servers.url}${path}?q=x&limit=${max + 1}`);
    expect(past.status).toBe(422);
    expect(((await past.json()) as { error: string }).error).toBe("invalid_limit");
  });
}
