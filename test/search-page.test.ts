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
