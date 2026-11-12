/** `GET /api/v1/changelog` carries a weak ETag and answers a repeat with 304, as the Atom feed does. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("GET /api/v1/changelog ETag", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  const saved = process.env["FORGE_COMMIT"];
  const get = (query = "", headers: Record<string, string> = {}) => fetch(`${servers.url}/api/v1/changelog${query}`, { headers });

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = "a".repeat(40);
    dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-etag-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const other = await createRepo(app, u.value, { name: "notes", visibility: "public" });
    if (!other.ok) throw new Error(String(other.error));
    const insertIssue = app.db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', ?4, ?5, 'closed')`,
    );
    const insertPull = app.db.query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid) VALUES (?1, ?2, 'b', 'base', '', ?3, ?4)`,
    );
    insertIssue.run("i1", made.value.id, 1, "First", u.value.id);
    insertPull.run("i1", made.value.defaultBranch, "2026-10-01T10:00:00.000Z", "oid-1");
    insertIssue.run("i2", made.value.id, 2, "Second", u.value.id);
    insertPull.run("i2", made.value.defaultBranch, "2026-10-02T10:00:00.000Z", "oid-2");
    insertIssue.run("i3", other.value.id, 1, "Elsewhere", u.value.id);
    insertPull.run("i3", other.value.defaultBranch, "2026-09-30T10:00:00.000Z", "oid-3");
    keepLive("alice/forge", ["oid-1"], 0);
  }, 30_000);

  afterAll(async () => {
    forgetLive();
    if (saved === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = saved;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a repeat is a 304 with no body and the same tag and cache-control", async () => {
    const first = await get();
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers.get("cache-control")).toBe("public, max-age=5");
    await first.text();
    const again = await get("", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("public, max-age=5");
  });

  test("?repo=all and the default carry different tags", async () => {
    const a = await get();
    const b = await get("?repo=all");
    expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
    const stale = await get("?repo=all", { "if-none-match": a.headers.get("etag") ?? "" });
    expect(stale.status).toBe(200);
  });

  test("a newly shipped pull makes the next answer a 200 with a new tag", async () => {
    const before = (await get()).headers.get("etag") ?? "";
    keepLive("alice/forge", ["oid-1", "oid-2"], 0);
    const after = await get("", { "if-none-match": before });
    expect(before).toMatch(/^W\//);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).toMatch(/^W\//);
    expect(after.headers.get("etag")).not.toBe(before);
  });
});
