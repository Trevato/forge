/** GET …/runs carries an ETag over the page; a repeat is a 304 until a run in it moves (#9148). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let owner = "";
let stranger = "";
let repoId = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-runs-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  owner = `forge_session=${createSession(app.db, made.value.id).token}`;
  const other = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
  });
  if (!other.ok) throw new Error(String(other.error));
  stranger = `forge_session=${createSession(app.db, other.value.id).token}`;
  const repo = await createRepo(app, made.value, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
}, 120_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const get = (c: string | undefined, tag?: string, query = "") =>
  fetch(`${servers.url}/api/v1/repos/alice/r/runs${query}`, {
    headers: { ...(c ? { cookie: c } : {}), ...(tag === undefined ? {} : { "if-none-match": tag }) },
  });

const add = (id: string, state: string) =>
  app.db.query("INSERT INTO run (id, repo_id, kind, state) VALUES (?, ?, 'deploy', ?)").run(id, repoId, state);

test("a repeat is a 304 with no body; headers say private, no-cache", async () => {
  add("run-001", "queued");
  const first = await get(owner);
  expect(first.status).toBe(200);
  const tag = first.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  expect(first.headers.get("vary")).toContain("authorization, cookie");
  await first.text();
  const again = await get(owner, tag);
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  expect(again.headers.get("server-timing") ?? "").toContain("tag");
  expect(again.headers.get("server-timing") ?? "").not.toContain("runs");
});

test("a new run, then queued → running → ok → each changes the tag", async () => {
  let tag = (await get(owner)).headers.get("etag")!;
  const step = async (sql: string) => {
    app.db.query(sql).run();
    const r = await get(owner, tag);
    expect(r.status).toBe(200);
    const next = r.headers.get("etag")!;
    expect(next).not.toBe(tag);
    await r.text();
    tag = next;
  };
  add("run-002", "queued");
  const added = await get(owner, tag);
  expect(added.status).toBe(200);
  tag = added.headers.get("etag")!;
  await added.text();
  await step("UPDATE run SET state='running', started_at='2026-01-01T00:00:00Z' WHERE id='run-002'");
  await step("UPDATE run SET turns=3, cost_usd=0.5 WHERE id='run-002'");
  await step("UPDATE run SET state='ok', finished_at='2026-01-01T00:01:00Z' WHERE id='run-002'");
});

test("a filter keeps its tag when a run that does not match changes", async () => {
  const first = await get(owner, undefined, "?state=ok");
  const tag = first.headers.get("etag")!;
  await first.text();
  app.db.query("UPDATE run SET state='running' WHERE id='run-001'").run();
  expect((await get(owner, tag, "?state=ok")).status).toBe(304);
  app.db.query("UPDATE run SET state='ok' WHERE id='run-001'").run();
  expect((await get(owner, tag, "?state=ok")).status).toBe(200);
});

test("owner and stranger tags differ; bad state is a 422 and unknown repo a 404, untagged", async () => {
  const a = await get(owner);
  const b = await get(stranger);
  expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
  await a.text(); await b.text();
  const bad = await get(owner, undefined, "?state=nope");
  expect(bad.status).toBe(422);
  expect(bad.headers.get("etag")).toBeNull();
  const missing = await fetch(`${servers.url}/api/v1/repos/alice/none/runs`, { headers: { cookie: owner } });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
});

test("a filter's page is its cursor and limit: a newer run that does not match moves the page", async () => {
  add("run-900", "ok");
  const first = await get(owner, undefined, "?state=ok&limit=1");
  const tag = first.headers.get("etag")!;
  await first.text();
  add("run-950", "failed");
  expect((await get(owner, tag, "?state=ok&limit=1")).status).toBe(304);
  add("run-960", "ok");
  expect((await get(owner, tag, "?state=ok&limit=1")).status).toBe(200);
});

test("a reader of a private repository's runs only: a stranger gets 404 and no tag, with any If-None-Match", async () => {
  const made = app.db.query("SELECT owner_id AS o FROM repo WHERE id = ?").get(repoId) as { o: string };
  expect(made).toBeTruthy();
  app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?").run(repoId);
  try {
    const ownerTag = (await get(owner)).headers.get("etag")!;
    for (const tag of [ownerTag, 'W/"x"', "*"]) {
      const r = await get(stranger, tag);
      expect(r.status).toBe(404);
      expect(r.headers.get("etag")).toBeNull();
    }
    const anon = await get(undefined, ownerTag);
    expect(anon.status).toBe(404);
    expect(anon.headers.get("etag")).toBeNull();
  } finally {
    app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?").run(repoId);
  }
});
