/**
 * A list the API answers is `{ items, next_cursor }`, never a bare JSON array
 * (#5062). Every GET route of `apiRoutes` is read from the router's own table
 * and called with a fixture's names filled in; a route that answers an array
 * fails unless `BARE` names it with the open issue that will change it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { apiRoutes } from "../src/http/api.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

/** Routes that answer a bare array today → the open issue that changes them. */
const BARE: Record<string, string> = {
  "/api/v1/repos/:owner/:name/commits": "#5083",
  "/api/v1/user/origins": "#4841",
  "/api/v1/user/origin-apps": "#4841",
  // The Gitea dialect a connecting forge reads is a bare array by definition (#8900).
  "/api/v1/user/repos": "#8900",
};

const FILL: Record<string, string> = {
  owner: "alice", username: "alice", name: "notes", number: "1", org: "alice",
  slug: "main", id: "1", team: "core", scope: "alice", job: "1", oid: "0", env: "prod",
};

const getPatterns = (): string[] => {
  const seen: string[] = [];
  const spy = { add(method: string, pattern: string) { if (method === "GET") seen.push(pattern); return spy; } };
  apiRoutes(spy as never);
  return [...new Set(seen)];
};

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-listshape-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  createIssue(app.db, { repoId: made.value.id, title: "one", body: "b", authorId: admin.value.id });
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

async function answersArray(pattern: string): Promise<boolean> {
  const path = pattern.replace(/:([a-z_]+)/g, (_, k: string) => FILL[k] ?? "x").replace(/\*[a-z_]+/, "x");
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("json")) return false;
  return Array.isArray(JSON.parse(text));
}

test("no GET route answers a bare array unless the allowlist names it", async () => {
  const bare: string[] = [];
  for (const pattern of getPatterns()) if (await answersArray(pattern)) bare.push(pattern);
  expect(bare.filter((p) => !(p in BARE))).toEqual([]);
});

test("an allowlisted route that no longer answers a bare array leaves the list", async () => {
  const patterns = new Set(getPatterns());
  const stale: string[] = [];
  for (const [pattern, issue] of Object.entries(BARE)) {
    expect(issue).toMatch(/^#\d+$/);
    if (!patterns.has(pattern) || !(await answersArray(pattern))) stale.push(pattern);
  }
  expect(stale).toEqual([]);
});
