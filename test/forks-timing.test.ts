/** A repository's forks page names its phases in Server-Timing (#3310, #3334). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fktime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const names = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!).filter((n) => n !== "app");

test("the forks page names session, repository, forks, fork-tree, lineage, drift and render, in order", async () => {
  const res = await fetch(`${servers.url}/alice/notes/forks`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  await res.text();
  expect(names(res)).toEqual(["session", "repository", "forks", "fork-tree", "lineage", "drift", "render"]);
});

test("a missing repository still names session and repository", async () => {
  const res = await fetch(`${servers.url}/alice/nope/forks`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(404);
  await res.text();
  expect(names(res)).toEqual(["session", "repository"]);
});
