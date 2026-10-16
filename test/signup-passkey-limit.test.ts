/**
 * Passkey sign-up asks signupAllowed before it makes an account: the sixth
 * account in a minute from one source is refused with the wait, and nothing
 * is made for it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { device } from "./helpers/passkey.ts";

let dataDir: string;
let app: App;
let servers: Servers;

const post = (path: string, body: unknown) =>
  fetch(`${servers.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function signUpAs(name: string) {
  const d = await device(new URL(servers.url).origin, new URL(servers.url).hostname);
  const email = `${name}@f.dev`;
  const o = (await (await post("/signup/passkey/options", { username: name, email })).json()) as any;
  return post("/signup/passkey", { username: name, email, challenge: o.challenge, ...(await d.create(o.challenge)) });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-signup-limit-"));
  app = createApp({ dataDir, port: 0, passkeyOnlySignup: true });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a passkey sign-up past the per-source limit is refused with the wait", async () => {
  for (let i = 0; i < 5; i++) expect((await signUpAs(`lim${i}`)).status).toBe(201);
  const res = await signUpAs("lim5");
  expect(res.status).toBe(429);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(((await res.json()) as any).message).toContain("Try again in");
  expect(getUserByName(app.db, "lim5")).toBeUndefined();
});
