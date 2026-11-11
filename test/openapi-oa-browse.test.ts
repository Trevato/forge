/** Browsing an origin's issues and pulls is in the served OpenAPI document. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openapi } from "../src/contract/openapi.ts";
import { serve, type Servers } from "../src/http/server.ts";

const B = "/api/v1/user/origins/{id}/browse/{owner}/{name}";
const PATHS = [`${B}/issues`, `${B}/issues/{number}`, `${B}/pulls`, `${B}/pulls/{number}`];

let dataDir: string;
let app: App;
let servers: Servers;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-openapi-browse-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each browse path is a GET in the document, with its refusals and untrusted note", () => {
  const paths = openapi("http://x", "1", "admin").paths as Record<string, Record<string, any>>;
  for (const path of PATHS) {
    const get = paths[path]?.get;
    expect(get, path).toBeDefined();
    expect(get.security).toBeDefined();
    expect(get.summary).toContain("untrusted");
    expect(get.responses["401"] ?? get.responses.default).toBeDefined();
    expect(JSON.stringify(get.responses)).toContain("origin_unreachable");
  }
  const names = paths[PATHS[0]!]!.get.parameters.map((p: any) => p.name);
  expect(names).toEqual(["id", "owner", "name", "state", "label", "author", "q", "cursor"]);
});

test("the unauthorized refusal the rows name is what the route answers", async () => {
  const res = await fetch(`${base}${PATHS[0]!.replace("{id}", "o").replace("{owner}", "a").replace("{name}", "b")}`);
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
});
