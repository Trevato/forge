/** A webhook sent to production's stable address reaches a pull's preview. */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { openIssue } from "../src/actions/issues.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { setSealed } from "../src/core/sealed.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { HOOK_MAX_BYTES, HOOK_PREFIX, hookPath } from "../src/apps/hook_relay.ts";
import { proxyApp, type AppTarget } from "../src/apps/proxy.ts";

test("hookPath names the pull and the path, and refuses what could escape", () => {
  expect(hookPath(`${HOOK_PREFIX}7/stripe/webhook`)).toEqual({ pull: 7, path: "/stripe/webhook" });
  expect(hookPath(`${HOOK_PREFIX}12`)).toEqual({ pull: 12, path: "/" });
  for (const bad of ["0/x", "x/y", "07/x", "7/../x", "7//evil.test", "7/__forge/note", "", "7/a b"])
    expect(hookPath(`${HOOK_PREFIX}${bad}`)).toBeUndefined();
  expect(hookPath("/other/7/x")).toBeUndefined();
});

const target = { app: { id: "a", slug: "shop" }, env: "production" } as unknown as AppTarget;
const bare = { envStatus: () => undefined } as never;
const call = (method: string, path: string, init: RequestInit = {}) =>
  proxyApp(bare, new Request(`http://shop.test${path}`, { method, ...init }), target, {} as never);

test("only POST is relayed, and only to a preview that exists", async () => {
  expect((await call("GET", `${HOOK_PREFIX}7/x`))?.status).toBe(405);
  expect((await call("POST", `${HOOK_PREFIX}7/x`, { body: "{}" }))?.status).toBe(404);
  expect((await call("POST", `${HOOK_PREFIX}x`, { body: "{}" }))?.status).toBe(404);
});

test("a body over the limit is refused before the preview is woken", async () => {
  const live = { envStatus: () => ({ state: "running" }), urlFor: () => "http://shop--7.test" } as never;
  const r = await proxyApp(
    live,
    new Request(`http://shop.test${HOOK_PREFIX}7/x`, {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024) },
      body: "{}",
    }),
    target,
    {} as never,
  );
  expect(r?.status).toBe(413);
});

// The forwarding path, against a real runtime and a real preview process.
quietLogs();
let dataDir: string;
let app: App;
let runtime: AppsRuntime;
let backend: ReturnType<typeof Bun.serve>;
let seen: { method: string; path: string; body: string; sig: string | null; host: string | null }[] = [];
let status: ReturnType<typeof spyOn>;
let live: AppTarget;
let openNumber: number;
let sealedNumber: number;

beforeAll(async () => {
  backend = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        body: await req.text(),
        sig: req.headers.get("stripe-signature"),
        host: req.headers.get("host"),
      });
      return new Response("received", { status: 202 });
    },
  });
  dataDir = await mkdtemp(join(tmpdir(), "forge-hook-relay-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: 0,
    forgeUrl: "http://forge.test",
    concurrency: 1,
  });
  await runtime.start();
  status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
    (_a, env) =>
      ({ env, state: "running", port: backend.port, commitOid: "a".repeat(40) }) as EnvStatus,
  );
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await newApp(app, u.value, { name: "shop", description: "A shop", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  live = { app: made.value.app, env: "production" } as AppTarget;
  const open = openIssue(app, u.value, made.value.repo, { title: "open pull" });
  const sealed = openIssue(app, u.value, made.value.repo, { title: "sealed pull" });
  if (!open.ok || !sealed.ok) throw new Error("issues");
  openNumber = open.value.number;
  sealedNumber = sealed.value.number;
  setSealed(app.db, sealed.value.id, true);
}, 120_000);

afterAll(async () => {
  status.mockRestore();
  await runtime.stop();
  backend.stop(true);
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const relay = (n: number, init: RequestInit & { duplex?: string }, t: AppTarget = live) =>
  proxyApp(
    runtime,
    new Request(`http://shop.apps.test${HOOK_PREFIX}${n}/stripe/webhook`, { method: "POST", ...init }),
    t,
    {} as never,
  );

test("the preview sees the same path, body, signature and its own host", async () => {
  seen = [];
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const r = await relay(openNumber, { body, headers: { "stripe-signature": "t=1,v1=abc", host: "shop.apps.test" } });
  expect(r?.status).toBe(202);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.method).toBe("POST");
  expect(seen[0]!.path).toBe("/stripe/webhook");
  expect(seen[0]!.body).toBe(body);
  expect(seen[0]!.sig).toBe("t=1,v1=abc");
  expect(seen[0]!.host).toBe(new URL(runtime.urlFor(live.app, `pull-${openNumber}`)).host);
});

test("a chunked body over the limit is refused by the bytes read, with no content-length", async () => {
  seen = [];
  const chunk = new Uint8Array(256 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent > HOOK_MAX_BYTES + chunk.length) return c.close();
      sent += chunk.length;
      c.enqueue(chunk);
    },
  });
  const r = await relay(openNumber, { body: stream, duplex: "half" });
  expect(r?.status).toBe(413);
  expect(seen).toHaveLength(0);
  // A lying header is no better: a small claim over a large body.
  const lie = await relay(openNumber, {
    body: new Uint8Array(HOOK_MAX_BYTES + 1),
    headers: { "content-length": "10" },
  });
  expect(lie?.status).toBe(413);
  expect(seen).toHaveLength(0);
});

test("a sealed preview is refused although production is public", async () => {
  seen = [];
  const r = await relay(sealedNumber, { body: "{}" });
  expect(r?.status).toBe(404);
  expect(seen).toHaveLength(0);
});

test("a private app's preview is refused to a caller with no grant", async () => {
  seen = [];
  const priv = { app: { ...live.app, access: "private" }, env: "production" } as AppTarget;
  const r = await relay(openNumber, { body: "{}" }, priv);
  expect(r?.status).toBe(404);
  expect(seen).toHaveLength(0);
});
