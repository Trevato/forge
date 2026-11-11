/** A repository's labels, hooks, events and an issue's teams name their Server-Timing phases. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${servers.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
  });

const phases = async (path: string): Promise<{ status: number; names: string[] }> => {
  const res = await call(path);
  await res.arrayBuffer();
  const names = requestTiming(res).split(", ").filter(Boolean).map((p) => p.split(";")[0]!).filter((n) => n !== "db" && n !== "app");
  return { status: res.status, names };
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-rtime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
  const made = await call("/api/v1/repos", { method: "POST", body: JSON.stringify({ name: "yard", visibility: "private" }) });
  expect(made.status).toBe(201);
  const issue = await call("/api/v1/repos/alice/yard/issues", { method: "POST", body: JSON.stringify({ title: "one" }) });
  expect(issue.status).toBe(201);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const cases: [string, string, string][] = [
  ["labels", "/api/v1/repos/alice/yard/labels", "labels"],
  ["hooks", "/api/v1/repos/alice/yard/hooks", "hooks"],
  ["events", "/api/v1/repos/alice/yard/events", "events"],
  ["teams", "/api/v1/repos/alice/yard/issues/1/teams", "teams"],
];

for (const [name, path, read] of cases) {
  test(`${name} names session, ${read}, render in order`, async () => {
    const got = await phases(path);
    expect(got.status).toBe(200);
    expect(got.names).toEqual(["session", read, "render"]);
  });
  test(`${name} on a missing repository still names session`, async () => {
    const got = await phases(path.replace("/yard", "/nope"));
    expect(got.status).toBe(404);
    expect(got.names[0]).toBe("session");
  });
}
