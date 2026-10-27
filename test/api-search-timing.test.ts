/** The API's search names its Server-Timing phases (#3919). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-search-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`);
  const body = await res.text();
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the API search names session, then the parts asked for, then render", async () => {
  const got = await phases("/api/v1/search?q=forge&kind=repos");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "repos", "render"]);
  expect((await phases("/api/v1/search?q=forge")).names).toEqual(["session", "repos", "issues", "code", "render"]);
  expect(typeof JSON.parse(got.body)).toBe("object");
});
