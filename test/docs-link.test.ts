/** /docs sends a reader to the forge's documentation, from configuration only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo } from "../src/core/repos.ts";
import { UPSTREAM_REPO as UPSTREAM } from "../src/core/upstream.ts";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let servers: Servers;
let ownerId: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-docs-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "trevato", email: "t@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  ownerId = made.value.id;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${servers.url}${path}`, { redirect: "manual" });

test("without a public forge repository /docs goes to the upstream", async () => {
  const res = await get("/docs");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`${UPSTREAM}/tree/main/docs`);
  expect((await get("/docs/VISION.md")).headers.get("location")).toBe(`${UPSTREAM}/blob/main/docs/VISION.md`);
});

test("with a public forge repository /docs goes to a same-origin path", async () => {
  const made = await createRepo(app.db, app.reposRoot, { ownerId, name: "forge", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const res = await get("/docs");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/trevato/forge/tree/main/docs");
  expect((await get("/docs/PRINCIPLES.md")).headers.get("location")).toBe("/trevato/forge/blob/main/docs/PRINCIPLES.md");
});

test("a name outside [A-Za-z0-9_-]+ is a 404, never a redirect", async () => {
  for (const bad of ["..%2Fx", "..%2Fx.md", "a.b.md", "x", "%2F%2Fevil.md", ".md", "a%20b.md"])
    expect((await get(`/docs/${bad}`)).status).toBe(404);
});

test("the footer links Docs", async () => {
  expect(await (await fetch(`${servers.url}/changelog`)).text()).toContain('<a href="/docs">Docs</a>');
});

test("the ? sheet carries a Docs link", async () => {
  expect(await (await fetch(`${servers.url}/changelog`)).text()).toContain('<a class="btn" data-variant="link" href="/docs">Docs</a>');
});
