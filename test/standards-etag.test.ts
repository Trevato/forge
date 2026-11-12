/** The three discovery documents carry an ETag per origin and answer 304 to a match. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
const was = process.env["FORGE_VERSION"];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-standards-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  if (was === undefined) delete process.env["FORGE_VERSION"];
  else process.env["FORGE_VERSION"] = was;
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const BUILD_PATHS = ["/.well-known/mcp.json", "/.well-known/forge"];

for (const path of ["/.well-known/api-catalog", ...BUILD_PATHS]) {
  test(`${path}: etag, cache-control, cors, 304 on a match`, async () => {
    const url = `${servers.url}${path}`;
    const first = await fetch(url);
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("cache-control")).toContain("max-age");
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    await first.text();
    const again = await fetch(url, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
    expect(await again.text()).toBe("");
    const weak = await fetch(url, { headers: { "if-none-match": `W/${etag}` } });
    expect(weak.status).toBe(304);
    expect(weak.headers.get("etag")).toBe(etag);
  });
}

for (const path of BUILD_PATHS) {
  test(`${path}: a new build changes the etag`, async () => {
    process.env["FORGE_VERSION"] = "1.0.0";
    const url = `${servers.url}${path}`;
    const etag = (await fetch(url)).headers.get("etag")!;
    process.env["FORGE_VERSION"] = "2.0.0";
    const changed = await fetch(url, { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });
}

test("mcp.json: a changed plugin repo changes the etag", async () => {
  const url = `${servers.url}/.well-known/mcp.json`;
  const before = (await fetch(url)).headers.get("etag")!;
  const alice = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!alice.ok) throw new Error(alice.error);
  const r = await createRepo(app, alice.value, { name: "forge", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  (app.config as { forgeRepo?: string }).forgeRepo = "alice/forge";
  const after = await fetch(url, { headers: { "if-none-match": before } });
  expect(after.status).toBe(200);
  expect(after.headers.get("etag")).not.toBe(before);
});

// /.well-known/forge names no origin, so its body is the same everywhere.
for (const path of ["/.well-known/api-catalog", "/.well-known/mcp.json"]) {
  test(`${path}: each origin gets its own body and etag`, async () => {
    const url = `${servers.url}${path}`;
    const a = await fetch(url);
    const other = await fetch(url, { headers: { host: "other.example" } });
    const [bodyA, bodyOther] = [await a.text(), await other.text()];
    expect(bodyOther).toContain("http://other.example");
    expect(bodyOther).not.toContain(new URL(servers.url).host);
    expect(other.headers.get("etag")).not.toBe(a.headers.get("etag"));
    expect(bodyA).not.toBe(bodyOther);
  });
}
