/** The served OpenAPI document describes a repository's flow and the crew's scorecard. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let servers: Servers;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-openapi-flow-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("GET /contract/openapi.json has the flow and the scorecard", async () => {
  const res = await fetch(`${servers.url}/contract/openapi.json`);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as any;

  const flow = doc.paths["/api/v1/repos/{owner}/{name}/flow"].get;
  expect(flow.security).toBeUndefined();
  expect(flow.summary).toContain("{ open, live }");
  expect(flow.responses.default.description).toContain("`not_found`");

  const card = doc.paths["/api/v1/crew/scorecard"].get;
  expect(card.security).toBeDefined();
  expect(card.summary).toContain("{ agents:");
  expect(card.responses.default.description).toContain("`unauthorized`");
  expect(card.responses.default.description).toContain("`forbidden`");
});
