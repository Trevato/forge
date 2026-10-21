/**
 * `GET /metrics` serves the open egress connections with repository names in
 * its labels, so it is a site admin's alone (#3719).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { startEgress, type Egress } from "../src/apps/egress.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let admin: string;
let adminRo: string;
let member: string;
let agent: string;
let memberCookie: string;
let egress: Egress;
let camera: { port: number; stop(close?: boolean): void };
let client: Awaited<ReturnType<typeof Bun.connect>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "egress-metrics-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst = false): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob");
  const made = await createAgent(app, alice, { username: "scout" });
  if (!made.ok) throw new Error(String(made.error));
  admin = createToken(app.db, alice.id, "t", "admin").token;
  adminRo = createToken(app.db, alice.id, "t", "ro").token;
  member = createToken(app.db, bob.id, "t", "ro").token;
  agent = createToken(app.db, made.value.user.id, "t", "ro").token;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
  });
  memberCookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  camera = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const listen = probe.port;
  probe.stop(true);
  egress = startEgress(
    { tcp: listen },
    { hosts: [], origins: [{ host: "127.0.0.1", port: camera.port }], label: "app:cam/main" },
  );
  let reply = "";
  client = await Bun.connect<undefined>({
    hostname: "127.0.0.1",
    port: listen,
    socket: { data: (_s, c) => void (reply += new TextDecoder().decode(c)) },
  });
  client.write(`CONNECT 127.0.0.1:${camera.port} HTTP/1.1\r\n\r\n`);
  while (!reply.includes("200")) await Bun.sleep(10);
}, 60_000);

afterAll(async () => {
  client.terminate();
  egress.close();
  camera.stop(true);
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/metrics`, { headers });

test("anonymous, a member and an agent are told it is not there", async () => {
  expect((await get()).status).toBe(404);
  expect((await get({ cookie: memberCookie })).status).toBe(404);
  expect((await get({ authorization: `Bearer ${member}` })).status).toBe(404);
  expect((await get({ authorization: `Bearer ${agent}` })).status).toBe(404);
});

test("a site admin reads the open connections as Prometheus text", async () => {
  const res = await get({ authorization: `Bearer ${adminRo}` });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/plain; version=0.0.4");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toContain(
    `forge_egress_connections{repo="app:cam/main",destination="127.0.0.1:${camera.port}"} 1`,
  );
  expect((await get({ authorization: `Bearer ${admin}` })).status).toBe(200);
});
