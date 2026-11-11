/** The OpenAPI document describes a repository itself, and its refusals are the ones the routes answer. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { openapi } from "../src/contract/openapi.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const R = "/api/v1/repos/{owner}/{name}";
const WANT: readonly (readonly [string, string])[] = [
  ["post", "/api/v1/repos"],
  ["get", R],
  ["patch", R],
  ["delete", R],
  ["get", `${R}/upstream`],
  ["put", `${R}/upstream`],
  ["post", `${R}/upstream/check`],
];

test("each repository path and method is in the document", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const [method, path] of WANT) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
  expect(doc.paths["/api/v1/repos"].post.responses["201"]).toBeDefined();
});

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-openapi-repo-"));
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
  if (!made.ok) throw new Error(String(made.error));
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const repo = await createRepo(app, made.value, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body: unknown): Promise<{ status: number; error: unknown }> {
  const res = await fetch(`${servers.url}${path}`, {
    method,
    headers: { cookie, origin: servers.url, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  return { status: res.status, error: json.error };
}

function documented(method: string, path: string, code: string): void {
  const doc = openapi("https://f.test", "1", "admin") as any;
  expect(doc.paths[path][method].responses.default.description).toContain(`\`${code}\``);
}

test("one refusal per row is the code the route answers", async () => {
  const cases: readonly [string, string, string, unknown, string, number][] = [
    ["post", "/api/v1/repos", "/api/v1/repos", { name: "bad name!" }, "invalid_name", 422],
    ["patch", R, "/api/v1/repos/alice/r", { archived: "yes" }, "bad_archived", 422],
    ["put", `${R}/upstream`, "/api/v1/repos/alice/r/upstream", { url: "https://x.test/r.git" }, "bad_enabled", 422],
    ["delete", R, "/api/v1/repos/alice/none", {}, "not_found", 404],
    ["get", R, "/api/v1/repos/alice/none", undefined, "not_found", 404],
  ];
  for (const [method, doc, path, body, code, status] of cases) {
    const got = await call(method.toUpperCase(), path, body);
    expect(got.status).toBe(status);
    expect(got.error).toBe(code);
    documented(method, doc, code);
  }
});
