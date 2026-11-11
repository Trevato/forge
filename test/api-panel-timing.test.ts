/** The API's board panel read names its Server-Timing phases (#3920). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBoard } from "../src/actions/boards.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-panel-timing-"));
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
  token = createToken(app.db, made.value.id, "t", "admin").token;
  const done = await writeBoard(app, made.value, "usage", {
    title: "Usage",
    range: "24h",
    refresh: "off",
    panels: [
      { title: "By target", chart: "bar", query: { source: "machine", aggregate: "count", groupBy: "target" }, w: 1, h: 1 },
    ],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[]; res: Response }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), res };
}

test("a panel read names session, board, query and render", async () => {
  const got = await phases("/api/v1/boards/usage/panels/0");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "board", "query", "render"]);
  expect(got.res.headers.get("cache-control")).toBe("private, no-store");
});

test("the CSV answer names the same phases", async () => {
  const got = await phases("/api/v1/boards/usage/panels/0?format=csv");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "board", "query", "render"]);
  expect(got.res.headers.get("cache-control")).toBe("private, no-store");
});

test("refusals keep their status and name the phases they reached", async () => {
  const missing = await phases("/api/v1/boards/usage/panels/9");
  expect(missing.status).toBe(404);
  expect(missing.names).toEqual(["session", "board"]);
  const bad = await phases("/api/v1/boards/usage/panels/0?format=xml");
  expect(bad.status).toBe(422);
  expect(bad.names).toEqual(["session", "board"]);
});
