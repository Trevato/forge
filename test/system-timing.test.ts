/** `/system` names session, reader, sample, caps, memory and render in Server-Timing (#3273). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let token = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-system-timing-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  token = createToken(app.db, r.value.id, "t", "admin").token;
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("GET /system names its phases", async () => {
  const res = await fetch(`${servers.url}/system`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "reader", "sample", "caps", "memory", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});

test("a non-admin is refused at the admin gate, before any reader, sample or memory phase", async () => {
  const r = await createUser(app.db, {
    origin: "everyday",
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!r.ok) throw new Error(r.error);
  const bob = createToken(app.db, r.value.id, "t", "admin").token;
  const res = await fetch(`${servers.url}/system`, { headers: { authorization: `Bearer ${bob}` } });
  expect(res.status).toBe(403);
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]);
  for (const name of ["reader", "sample", "caps", "memory", "render"]) expect(names).not.toContain(name);
});
