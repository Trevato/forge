/** GET /forges/name/<name>: free, taken, invalid or reserved, as the door would say it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";
import { NAME_PER_MINUTE } from "../src/web/pages/forge-name.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-name-"));
  app = createApp({ dataDir: dir, port: 0 });
  await mkdir(join(dir, "spawn"), { recursive: true });
  await writeFile(join(dir, "spawn", "acme.json"), JSON.stringify({ name: "acme", bodyId: "b1", done: true }));
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const ask = async (name: string) => {
  const res = await fetch(`${servers.url}/forges/name/${encodeURIComponent(name)}`);
  return { res, body: (await res.json()) as { verdict?: string; why?: string } };
};

test("free, taken, invalid and reserved", async () => {
  expect((await ask("fresh-one")).body.verdict).toBe("free");
  expect((await ask("acme")).body.verdict).toBe("taken");
  for (const bad of ["Bad Name!", "x".repeat(41), "-a"]) expect((await ask(bad)).body.verdict).toBe("invalid");
  const admin = await ask("admin");
  expect(admin.body.verdict).toBe("reserved");
  expect(admin.body.why).toBeTruthy();
});

test("the answer is not cached and keeps the security floor", async () => {
  const { res } = await ask("fresh-two");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("the door refuses what the verdict calls reserved or invalid", async () => {
  const { spawnDoor } = await import("../src/spawn/door.ts");
  const ctx = { app, request: new Request(`${servers.url}/`), params: {}, auth: {} } as never;
  for (const name of ["admin", "Bad Name!"]) {
    const door = await spawnDoor(ctx, undefined, { name, dryRun: true });
    expect(door.status).toBe(422);
    expect(String(door.body["message"])).toContain("name");
    expect(door.body["error"]).toBe("invalid");
  }
});

test("past the per-minute count an address is answered 429 with retry-after", async () => {
  let last = new Response();
  for (let i = 0; i < NAME_PER_MINUTE + 2; i++) last = await fetch(`${servers.url}/forges/name/spam`);
  expect(last.status).toBe(429);
  expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
});

test("the terminal asks the same question: offered to a guest only, and says what the route says", async () => {
  const { forgeNameCommand } = await import("../src/tui/screens/forgename.ts");
  const { forgeNameVerdict } = await import("../src/actions/spawn.ts");
  const toasts: string[] = [];
  let pushed: { key: (e: unknown) => boolean } | undefined;
  const ctx = { push: (s: never) => (pushed = s), toast: (m: string) => toasts.push(m), invalidate: () => {} } as never;
  expect(forgeNameCommand({ app, signedIn: true } as never, ctx)).toEqual([]);
  const [cmd] = forgeNameCommand({ app, signedIn: false } as never, ctx);
  expect(cmd?.id).toBe("forge-name");
  cmd?.run();
  expect(pushed).toBeDefined();
  for (const name of ["admin", "Bad Name!", "acme", "some-new-name"]) {
    const v = await forgeNameVerdict(app, name.toLowerCase());
    expect(v.verdict).toBe({ admin: "reserved", "Bad Name!": "invalid", acme: "taken", "some-new-name": "free" }[name] as never);
  }
});
