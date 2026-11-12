/** A page served through the proxy with the toolbar keeps a validator (#9136). */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

let dataDir: string;
let record: AppTarget["app"];
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let backend: ReturnType<typeof Bun.serve>;
let toolbar: boolean | undefined = undefined;
let page = "<!doctype html><html><head><title>a</title></head><body>one</body></html>";
let etagNow = 'W/"one"';
let status: ReturnType<typeof spyOn>;

beforeAll(async () => {
  backend = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/missing")
        return new Response(page, { status: 404, headers: { "content-type": "text/html", etag: '"v"' } });
      if (path === "/private")
        return new Response(page, { headers: { "content-type": "text/html", etag: '"v"', "cache-control": "private, no-store" } });
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", etag: etagNow } });
    },
  });
  dataDir = await mkdtemp(join(tmpdir(), "forge-proxy-timing-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: DOMAIN,
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
  });
  await runtime.start();
  status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
    () =>
      ({
        env: "production",
        state: "running",
        port: backend.port,
        commitOid: "a".repeat(40),
        toolbar,
      }) as EnvStatus,
  );
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const made = await newApp(app, a.value, {
    name: "notes",
    description: "A place for words",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  record = made.value.app;
}, 120_000);

afterAll(async () => {
  status.mockRestore();
  await runtime.stop();
  servers.stop();
  backend.stop(true);
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const HEADERS = { host: `notes.${DOMAIN}`, accept: "text/html" };
const get = (path: string, extra: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers: { ...HEADERS, ...extra }, redirect: "manual" });

test("a tagged page is 200 with a weak etag, then 304 on a repeat", async () => {
  const first = await get("/");
  expect(first.status).toBe(200);
  const tag = first.headers.get("etag")!;
  expect(tag).toStartWith("W/");
  expect(await first.text()).toContain("one");
  const again = await get("/", { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
});

test("a changed upstream body or toolbar is 200 with a new tag", async () => {
  const tag = (await get("/")).headers.get("etag")!;
  page = page.replace("one", "two");
  etagNow = 'W/"two"';
  const changed = await get("/", { "if-none-match": tag });
  expect(changed.status).toBe(200);
  const next = changed.headers.get("etag")!;
  expect(next).not.toBe(tag);
  expect((await get("/", { "if-none-match": next })).status).toBe(304);
  const opts = runtime.options as { forgeUrl: string };
  const was = opts.forgeUrl;
  opts.forgeUrl = "http://other.test";
  try {
    const moved = await get("/", { "if-none-match": next });
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(next);
  } finally {
    opts.forgeUrl = was;
  }
});

test("a private page and a non-200 carry no etag", async () => {
  expect((await get("/private")).headers.get("etag")).toBeNull();
  const missing = await get("/missing");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
});

test("a signed-in visitor's page carries no etag, with the proof or without it", async () => {
  const grant = signGrant(dataDir, { app: record, env: "production" } as AppTarget, 60_000, Date.now(), {
    id: "u1",
    name: "alice",
    role: "admin",
  });
  const cookie = `forge_grant_${record.id.slice(-8)}=${grant}`;
  // A document load is handed the one-use proof.
  const withProof = await get("/", { cookie, "sec-fetch-dest": "document" });
  expect(withProof.status).toBe(200);
  expect(withProof.headers.get("cache-control")).toBe("private, no-store");
  expect(withProof.headers.get("etag")).toBeNull();
  // A script's own fetch gets no proof, yet is still a signed-in page: still untagged.
  const bare = await get("/", { cookie, "sec-fetch-dest": "empty" });
  expect(bare.status).toBe(200);
  expect(bare.headers.get("etag")).toBeNull();
  // And a guest's tag never answers a signed-in revisit with 304.
  const guestTag = (await get("/")).headers.get("etag")!;
  expect((await get("/", { cookie, "if-none-match": guestTag })).status).toBe(200);
});
