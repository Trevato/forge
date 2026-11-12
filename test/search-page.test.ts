/**
 * /search is fast and works with no script (#9705). Speed is held as
 * work (greps run, SQL statements), never a wall clock (#4429).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { grepCount } from "../src/core/search.ts";
import { serve } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

const STATEMENT_CEILING = 40;
let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let bearer = "";

const get = (path: string) =>
  fetch(servers.url + path, { headers: { authorization: `Bearer ${bearer}` } });
const post = (path: string, body: unknown) =>
  fetch(servers.url + path, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The `app` phase of Server-Timing (the handler's own time, not the proxy's), or NaN. Reported, never judged (#4429). */
function appMs(res: Response): number {
  const part = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith("app;"));
  return Number(/dur=([\d.]+)/.exec(part ?? "")?.[1] ?? "NaN");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-search-page-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, {
    username: "alice", email: "alice@forge.local", password: "a-good-passphrase",
  });
  if (!made.ok) throw new Error(made.error);
  bearer = createToken(app.db, made.value.id, "t", "admin").token;
  // Every repo has a commit: an empty repo has no oid to key the grep cache on.
  for (const name of ["flux-engine", "flux-notes", "plain-repo"]) {
    await post("/api/v1/repos", {
      name, visibility: "public", description: name === "plain-repo" ? "nothing here" : "a flux thing",
    });
    await post(`/api/v1/repos/alice/${name}/contents`, {
      branch: "main",
      message: "first",
      files: [{ path: "src/flux.ts", content: "export const flux = 1;\n" }],
    });
  }
  for (const title of ["flux capacitor overheats", "flux docs are thin", "unrelated"]) {
    await post("/api/v1/repos/alice/flux-engine/issues", { title, body: "" });
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a warm query is cache-shaped: no grep, and a bounded number of statements", async () => {
  const first = await get("/search?q=flux");
  expect(first.status).toBe(200);
  await first.text();
  const ran = grepCount();
  const second = await get("/search?q=flux");
  const body = await second.text();
  expect(second.status).toBe(200);
  expect(body).toContain("flux-engine");
  // The 50 ms bound, as work (#4429): a lost cache re-spawns git grep, and a
  // page that goes N+1 raises the statement count; both fail on any runner.
  expectWork(grepCount() - ran, { max: 0 });
  expectWork(await requestStatements(app.db, servers.url + "/search?q=flux", { headers: { authorization: `Bearer ${bearer}` } }), { max: STATEMENT_CEILING });
  expectWork(grepCount() - ran, { max: 0 });
  // The app phase is sent (and is the one to read, not a sum with the proxy's).
  expect(appMs(second)).not.toBeNaN();
});

test("the form is a plain GET form", async () => {
  const html = await (await get("/search?q=flux")).text();
  const form = /<form\b[^>]*role="search"[^>]*>/.exec(html)?.[0] ?? "";
  expect(form).toMatch(/method="get"/i);
  expect(form).toMatch(/action="\/search"/);
  expect(html).toMatch(/<input[^>]*type="search"[^>]*name="q"|<input[^>]*name="q"[^>]*type="search"/);
  expect(html).toMatch(/<button[^>]*type="submit"/);
});

test("results are in the server's HTML with every script stripped", async () => {
  const html = (await (await get("/search?q=flux")).text()).replace(/<script\b[\s\S]*?<\/script>/gi, "");
  expect(html).not.toMatch(/<script\b/i);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
  // A result row is a link to the thing itself: repos, issues and code.
  expect(hrefs).toContain("/alice/flux-engine");
  expect(hrefs).toContain("/alice/flux-notes");
  expect(hrefs.some((h) => h.startsWith("/alice/flux-engine/issues/"))).toBe(true);
  expect(hrefs.some((h) => h.startsWith("/alice/flux-engine/") && h.includes("src/flux.ts"))).toBe(true);
  expect(html).toContain("flux capacitor overheats");
  // plain-repo matches by its code only: it has a code row, and no repo row.
  expect(hrefs).not.toContain("/alice/plain-repo");
  expect(hrefs.some((h) => h.startsWith("/alice/plain-repo/blob/"))).toBe(true);
});

/** The release probe's `/search?q=a` (#11120): one letter greps no code, says so, and is bounded work. */
test("a one-letter query greps nothing, says why, and runs a bounded number of statements", async () => {
  const anon = (path: string) => fetch(servers.url + path);
  for (const ask of [get, anon]) {
    const ran = grepCount();
    const res = await ask("/search?q=a");
    const html = await res.text();
    expect(res.status).toBe(200);
    expectWork(grepCount() - ran, { max: 0 });
    expect(html).toContain("data-code-short");
    expect(html).toContain("Code is searched for 2 or more characters");
    // Repositories and issues still answer the one letter.
    expect(html).toContain("/alice/flux-engine");
  }
  const ran = grepCount();
  expectWork(await requestStatements(app.db, servers.url + "/search?q=a", { headers: { authorization: `Bearer ${bearer}` } }), { max: STATEMENT_CEILING });
  expectWork(await requestStatements(app.db, servers.url + "/search?q=a"), { max: STATEMENT_CEILING });
  expectWork(grepCount() - ran, { max: 0 });
  // Asking for code alone says the same, and a repo-scoped kind does not.
  expect(await (await get("/search?q=a&kind=code")).text()).toContain("data-code-short");
  expect(await (await get("/search?q=a&kind=repos")).text()).not.toContain("data-code-short");
});

test("two letters and more still grep the code", async () => {
  const html = await (await get("/search?q=fl")).text();
  expect(html).not.toContain("data-code-short");
  expect(html).toContain("src/flux.ts");
});

test("the API and the MCP search tool answer one letter the same: no code, and a note", async () => {
  const ran = grepCount();
  const api = (await (await get("/api/v1/search?q=a")).json()) as { code: unknown[]; note?: string; repos: unknown[] };
  expect(api.code).toEqual([]);
  expect(api.note).toContain("2 or more characters");
  expect(api.repos.length).toBeGreaterThan(0);
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { q: "a" } } }),
  });
  const text = await res.text();
  expect(text).toContain("2 or more characters");
  expectWork(grepCount() - ran, { max: 0 });
});
