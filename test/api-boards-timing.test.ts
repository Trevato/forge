/** The API's board reads name their Server-Timing phases (#3936). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { writeBoard } from "../src/actions/boards.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-api-boards-timing-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const w = await writeBoard(app, made.value, "ops", {
    title: "Ops", range: "all", refresh: "off",
    panels: [{ title: "Runs", chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 }],
  });
  if (!w.ok) throw new Error(JSON.stringify(w.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function phases(path: string, withCookie = true): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers: withCookie ? { cookie } : {} });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("each board read names session, boards, render in order", async () => {
  for (const path of ["/api/v1/boards", "/api/v1/boards/pins", "/api/v1/boards/ops"]) {
    const got = await phases(path);
    expect(got.status).toBe(200);
    expect(got.names).toEqual(["session", "boards", "render"]);
  }
  expect(JSON.parse((await phases("/api/v1/boards")).body).boards[0].slug).toBe("ops");
});

test("a missing board still names its phases", async () => {
  const got = await phases("/api/v1/boards/nope");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session", "boards", "render"]);
});

test("a refusal keeps its status and names session", async () => {
  const got = await phases("/api/v1/boards", false);
  expect(got.status).toBe(401);
  expect(got.names).toEqual(["session"]);
});
