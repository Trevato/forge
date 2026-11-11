/** GET /forges/<name>/ready: a child's liveness, never its claim code (#11201). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";
import { useProbe } from "../src/spawn/door.ts";
import { READY_PER_MINUTE } from "../src/web/pages/forge-ready.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let up = false;
const asked: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-ready-"));
  app = createApp({ dataDir: dir, port: 0 });
  await mkdir(join(dir, "spawn"), { recursive: true });
  await writeFile(join(dir, "spawn", "acme.json"), JSON.stringify({ name: "acme", bodyId: "b1", done: true, claimToken: "SECRET-CLAIM-CODE" }));
  useProbe(app, (url) => async () => {
    asked.push(url);
    return up;
  });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const ready = (name: string) => fetch(`${servers.url}/forges/${name}/ready`);

test("a child that does not answer yet is not ready; once it does, it is", async () => {
  up = false;
  let res = await ready("acme");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ready: false });
  up = true;
  res = await ready("acme");
  expect(await res.json()).toEqual({ ready: true });
  expect(asked.length).toBe(2);
});

test("the answer is not cached, holds no token and keeps the security floor", async () => {
  const res = await ready("acme");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).not.toBeNull();
  expect(res.headers.get("server-timing") ?? "").toContain("probe");
  expect(await res.text()).not.toContain("SECRET-CLAIM-CODE");
});

test("a name that is not a child's, or was never made here, is a 404 and nothing is probed", async () => {
  const before = asked.length;
  for (const name of ["Acme", "-acme", "acme-", "a_b", "x".repeat(41), "ghost"]) {
    const res = await ready(name);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  expect(asked.length).toBe(before);
});

test("one address is limited, and the refusal names the wait", async () => {
  let refused: Response | undefined;
  for (let i = 0; i < READY_PER_MINUTE + 5 && refused === undefined; i++) {
    const res = await ready("acme");
    if (res.status === 429) refused = res;
  }
  expect(refused?.status).toBe(429);
  expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(refused?.headers.get("cache-control")).toBe("no-store");
});

test("the terminal's answer is the route's: childReady says yes, no, or unknown", async () => {
  const { childReady } = await import("../src/spawn/ready.ts");
  up = true;
  expect(await childReady(app, "acme")).toBe(true);
  up = false;
  expect(await childReady(app, "acme")).toBe(false);
  expect(await childReady(app, "nobody")).toBeUndefined();
});

test("the terminal door is the forges list's: offered to an admin, never to a member or a visitor", async () => {
  const { entry } = await import("../src/tui/screens/forgeready.ts");
  const as = (user: unknown) => ({ app, user }) as unknown as Parameters<typeof entry.offered>[0];
  expect(entry.offered(as({ isAdmin: true }))).toBe(true);
  expect(entry.offered(as({ isAdmin: false }))).toBe(false);
  expect(entry.offered(as(undefined))).toBe(false);
});
