/** The document describes itself, migration jobs and opening an app, and the routes answer as it says. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openapi } from "../src/contract/openapi.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { adminOpenapi } from "./helpers/openapi-doc.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-openapi-selfopen-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  token = tokenFor(app, "alice", "admin");
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const R = "/api/v1/repos/{owner}/{name}";
const WANT: readonly [string, string][] = [
  ["get", "/api/v1/openapi.json"],
  ["post", "/api/v1/migrate"],
  ["get", "/api/v1/migrate/{job}"],
  ["get", "/api/v1/migrate/{job}/stream"],
  ["get", `${R}/app/{env}/open`],
];

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${servers.url}${path}`, {
    redirect: "manual",
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
const refusal = async (res: Response) => ((await res.json()) as { error: string }).error;

/** The codes the document names for a row. */
function codes(path: string, method: string): string[] {
  const doc = openapi("http://x", "1", "admin") as any;
  const text: string = doc.paths[path][method].responses.default.description;
  return [...text.matchAll(/`(\w+)` \(/g)].map((m) => m[1]!);
}

test("each path and method is in the served document", async () => {
  const res = await adminOpenapi(app, servers.url, "/contract/openapi.json");
  const paths = ((await res.json()) as any).paths;
  for (const [method, path] of WANT) expect(paths[path]?.[method]).toBeDefined();
  expect(paths["/api/v1/openapi.json"].get.responses["308"]).toBeDefined();
  expect(paths["/api/v1/migrate"].post.responses["202"]).toBeDefined();
  expect(paths["/api/v1/migrate/{job}/stream"].get.summary).toContain("event stream");
});

test("the redirect to the document is a 308", async () => {
  const res = await call("/api/v1/openapi.json");
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe("/contract/openapi.json");
});

test("a bad source and a bad after answer the codes the rows name", async () => {
  const bad = await call("/api/v1/migrate", { method: "POST", body: "{}" });
  expect(bad.status).toBe(422);
  const code = await refusal(bad);
  expect(code).toBe("invalid_source");
  expect(codes("/api/v1/migrate", "post")).toContain(code);

  const after = await call("/api/v1/migrate", {
    method: "POST",
    body: JSON.stringify({ source: { url: "https://example.com/a/b" }, after: "burn" }),
  });
  expect(after.status).toBe(400);
  expect(codes("/api/v1/migrate", "post")).toContain(await refusal(after));
});

test("an unknown job, read or streamed, is not_found", async () => {
  for (const path of ["/api/v1/migrate/nope", "/api/v1/migrate/nope/stream"]) {
    const res = await call(path);
    expect(res.status).toBe(404);
    expect(codes(path.endsWith("stream") ? "/api/v1/migrate/{job}/stream" : "/api/v1/migrate/{job}", "get")).toContain(
      await refusal(res),
    );
  }
});

test("opening a repository with no app, or a bad environment, answers a listed code", async () => {
  const res = await call("/api/v1/repos/alice/none/app/production/open");
  expect(res.status).toBe(404);
  expect(codes(`${R}/app/{env}/open`, "get")).toContain(await refusal(res));
});
