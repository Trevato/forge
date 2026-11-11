/** The API's explore read names its Server-Timing phases (#3921). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-explore-timing-"));
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
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the API explore read names session, explore and render in order", async () => {
  const res = await fetch(`${servers.url}/api/v1/explore`, { headers: { cookie } });
  const body = JSON.parse(await res.text());
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  expect(res.status).toBe(200);
  expect(names.slice(names.indexOf("app") + 1)).toEqual(["session", "explore", "render"]);
  expect(Array.isArray(body.items)).toBe(true);
  expect(typeof body.query).toBe("string");
});
