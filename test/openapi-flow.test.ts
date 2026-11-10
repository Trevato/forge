/** The served OpenAPI document describes a repository's flow and the crew's scorecard. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_SCOPES } from "../src/core/oauth.ts";
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
  expect(flow.security).toEqual([]);
  expect(flow.summary).toContain("{ open, live }");
  expect(flow.responses.default.description).toContain("`not_found`");

  const card = doc.paths["/api/v1/crew/scorecard"].get;
  expect(card.security).toBeDefined();
  expect(card.summary).toContain("{ agents:");
  expect(card.responses.default.description).toContain("`unauthorized`");
  expect(card.responses.default.description).toContain("`forbidden`");
});

test("the document describes OAuth: authorization code, refresh, and OpenID discovery", async () => {
  const doc = (await (await fetch(`${servers.url}/contract/openapi.json`)).json()) as any;
  const schemes = doc.components.securitySchemes;
  const flow = schemes.oauth2.flows.authorizationCode;
  expect(flow.refreshUrl.endsWith("/oauth/token")).toBe(true);
  expect(flow.tokenUrl).toBe(flow.refreshUrl);
  expect(flow.authorizationUrl.endsWith("/oauth/authorize")).toBe(true);
  expect(Object.keys(flow.scopes)).toEqual([...OAUTH_SCOPES]);
  expect(schemes.openid.openIdConnectUrl.endsWith("/.well-known/openid-configuration")).toBe(true);
  const card = doc.paths["/api/v1/admin/invites"].post;
  expect(card.security).toEqual([{ token: [] }, { oauth2: ["rw"] }]);
  const read = Object.values(doc.paths).map((p: any) => p.get).find((op: any) => op?.security?.length);
  expect(read.security).toEqual([{ token: [] }, { oauth2: ["ro"] }]);
});

test("the served document says the telemetry flow read can be revalidated with a 304", async () => {
  const doc = (await (await fetch(`${servers.url}/contract/openapi.json`)).json()) as any;
  const op = doc.paths["/api/v1/telemetry/flow"].get;
  expect(op.responses["304"]).toBeDefined();
  expect(op.summary).toContain("cacheable by ETag");
  expect(op.summary).toContain("If-None-Match");
});

test("the description declares its origin, a bearer default, and marks open routes", async () => {
  const doc = (await (await fetch(`${servers.url}/contract/openapi.json`)).json()) as any;
  expect(doc.servers).toEqual([{ url: servers.url }]);
  expect(doc.components.securitySchemes.token).toEqual({ type: "http", scheme: "bearer" });
  expect(doc.security).toEqual([{ token: [] }]);
  expect(doc.paths["/api/v1/repos/{owner}/{name}/flow"].get.security).toEqual([]);
});
