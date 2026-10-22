/** A live preview is checked by webspec() and its findings are stored and shown (#2955). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { previewSpec } from "../src/apps/preview_spec.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { previewFindings } from "../src/core/preview_findings.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeHttp } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { checksText } from "../src/tui/screens/pull.ts";
import { findingsWords, pullPreviewFindings, previewFindings as stored } from "../src/core/preview_findings.ts";
import { specFindings } from "../src/web/pages/pull-spec.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let alice: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pspec-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 2,
  });
  await runtime.start();
  const made = await createUser(app.db, { origin: "seed", trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
}, 30_000);

afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function until<T>(f: () => T | null | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting");
}

test("a deployed preview's findings are stored under its run, and the run still passes", async () => {
  const made = await newApp(app, alice, { name: "specpreview", visibility: "public" });
  if (!made.ok) throw new Error("newApp");
  const repo = made.value.repo;
  // A known gap: the HTML carries no ETag.
  const committed = await commitToBranch(app, alice, repo, {
    branch: "gap",
    base: repo.defaultBranch,
    message: "a page with a known gap",
    files: [
      { path: "server.ts", content: 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("<!doctype html><html lang=en><title>t</title><p>hi", { headers: { "content-type": "text/html" } }) });\n' },
      { path: "forge.json", content: JSON.stringify({ app: { run: "bun server.ts", looks: ["/"] } }) },
    ],
  });
  expect(committed.ok).toBe(true);
  const opened = await openPull(app, alice, repo, {
    title: "gap",
    baseBranch: repo.defaultBranch,
    headBranch: "gap",
  });
  if (!opened.ok) throw new Error("openPull");
  const env = `pull-${opened.value.number}`;
  const run = await until(() => {
    const r = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find((x) => x.env === env);
    return r && ["ok", "failed"].includes(r.state) ? r : null;
  }, 60_000);
  const found = await until(() => previewFindings(app.db, run.id));
  expect(found.some((f) => f.check === "etag")).toBe(true);
  expect(listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find((x) => x.id === run.id)?.state).toBe("ok");
  expect(specFindings(found).text).toContain("finding");

  // The pull page itself shows them: the pull's check run is not the deploy run.
  expect(pullPreviewFindings(app.db, repo.id, env)).toEqual(found);
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const page = await forgeHttp(app)
    .handle(new Request(`http://forge.test/${repo.ownerName}/${repo.name}/pulls/${opened.value.number}`, { headers: { cookie } }))
    .then((r) => r.text());
  expect(page).toMatch(/Website spec: \d+ findings?/);
  expect(page).toContain("https://specification.website/#caching");
}, 90_000);

test("a webspec that cannot finish is one finding, and is stored", async () => {
  // Nothing listens on port 1: every fetch fails or the clock runs out.
  const found = await previewSpec("http://127.0.0.1:1", ["/"], 50);
  expect(found.length).toBeGreaterThanOrEqual(1);
  const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  const slow = await previewSpec(`http://127.0.0.1:${hung.port}`, ["/"], 100);
  hung.stop(true);
  expect(slow).toHaveLength(1);
  expect(slow[0]!.check).toBe("webspec");
  expect(slow[0]!.message).toContain("timed out");
});

test("a page that misses its first request is asked once more", async () => {
  let calls = 0;
  const flaky = Bun.serve({
    port: 0,
    fetch: () => (++calls === 1
      ? new Response("busy", { status: 503 })
      : new Response("<!doctype html><html lang=en><title>t</title><p>hi", { headers: { "content-type": "text/html" } })),
  });
  const found = await previewSpec(`http://127.0.0.1:${flaky.port}`, ["/"], 5_000);
  flaky.stop(true);
  expect(found.some((f) => f.check === "fetch")).toBe(false);
  expect(found.some((f) => f.check === "etag")).toBe(true);
});

test("the terminal's checks row carries the count, edge findings apart", () => {
  const found = [
    { path: "/", check: "etag", message: "m", section: "https://specification.website/#caching" },
    { path: "/", check: "compression", message: "m", section: "https://specification.website/", edge: true as const },
  ];
  expect(findingsWords(found)).toBe("website spec: 1 finding, 1 the edge owns");
  const run = { kind: "deploy", id: "r", commitOid: "abcdef0", summary: "", baseOid: "" } as never;
  const row = checksText({ state: "ok", run }, false, true, "main", false, "", "", findingsWords(found));
  expect(row).toContain("website spec: 1 finding, 1 the edge owns");
  expect(checksText({ state: "ok", run }, false, true)).not.toContain("website spec");
});

test("a stored finding that is not an https link is dropped before it can be rendered", () => {
  const made = app.db.query("SELECT id FROM run LIMIT 1").get() as { id: string } | null;
  if (!made) throw new Error("no run");
  app.db.query("INSERT OR REPLACE INTO preview_finding (run_id, findings) VALUES (?1, ?2)").run(
    made.id,
    JSON.stringify([
      { path: "/", check: "x", message: "m", section: "javascript:alert(1)" },
      { path: "/", check: "y", message: "m", section: "https://specification.website/#title" },
      "junk",
    ]),
  );
  expect(stored(app.db, made.id)?.map((f) => f.check)).toEqual(["y"]);
});
