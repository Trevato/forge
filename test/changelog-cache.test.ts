/** GET /changelog carries an ETag from what the page shows and answers a repeat with 304; only an anonymous answer is public (#11023). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("GET /changelog caching", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;
  const saved = process.env["FORGE_COMMIT"];
  const PUBLIC = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
  const get = (query = "", headers: Record<string, string> = {}) => fetch(`${servers.url}/changelog${query}`, { headers });
  const signed = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = "a".repeat(40);
    dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-cache-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    token = createToken(app.db, u.value.id, "t", "rw").token;
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

  test("a signed-in page is never public, and never carries the anonymous tag", async () => {
    const anon = await get();
    const mine = await get("", signed());
    expect(mine.status).toBe(200);
    const control = mine.headers.get("cache-control") ?? "";
    expect(control).toContain("private");
    expect(control).not.toContain("public");
    expect(control).not.toContain("s-maxage");
    expect(mine.headers.get("etag")).toMatch(/^W\//);
    expect(mine.headers.get("etag")).not.toBe(anon.headers.get("etag"));
    // The anonymous tag does not open the signed-in page.
    const crossed = await get("", signed({ "if-none-match": anon.headers.get("etag") ?? "" }));
    expect(crossed.status).toBe(200);
    // A cookie alone (a session the edge cannot see into) is not public either.
    const cookie = await get("", { cookie: "forge_theme=dark" });
    expect(cookie.headers.get("cache-control") ?? "").not.toContain("public");
  });

  test("an anonymous page is public with an ETag, and a repeat is a 304 with the floor headers", async () => {
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(PUBLIC);
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\//);
    await first.text();
    const again = await get("", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe(PUBLIC);
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("referrer-policy")).not.toBeNull();
    expect(again.headers.get("content-security-policy")).not.toBeNull();
  });

  test("a page that shows a flash is never tagged, and still clears it", async () => {
    const anon = await get();
    const flash = `forge_flash=${encodeURIComponent(JSON.stringify({ message: "Saved" }))}`;
    // Even holding the anonymous tag, the flash is shown (200), untagged, and cleared.
    const shown = await get("", { cookie: flash, "if-none-match": anon.headers.get("etag") ?? "" });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("etag")).toBeNull();
    expect(shown.headers.get("cache-control") ?? "").not.toContain("public");
    expect(shown.headers.get("set-cookie") ?? "").toContain("forge_flash=;");
    expect(await shown.text()).toContain("Saved");
  });

  test("a match is answered before the page is rendered", async () => {
    const etag = (await get()).headers.get("etag") ?? "";
    const again = await get("", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("server-timing") ?? "").not.toContain("render");
  });

  test("a signed-in repeat is a 304 too, still private", async () => {
    const first = await get("", signed());
    const etag = first.headers.get("etag") ?? "";
    await first.text();
    const again = await get("", signed({ "if-none-match": etag }));
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control") ?? "").toContain("private");
  });

  test("a filtered page has its own tag", async () => {
    const a = (await get()).headers.get("etag");
    const b = (await get("?repo=all")).headers.get("etag");
    expect(a).not.toBe(b);
    const stale = await get("?repo=all", { "if-none-match": a ?? "" });
    expect(stale.status).toBe(200);
  });

  test("the tag changes when a release lands", async () => {
    const before = (await get()).headers.get("etag") ?? "";
    keepLive("alice/forge", ["oid-1", "oid-2"], 0);
    const after = await get("", { "if-none-match": before });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before);
  });
});
