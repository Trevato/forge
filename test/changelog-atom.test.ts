/** `GET /changelog.atom` lists what went live, escaped, without what is only on its way; the page links it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { checkAtom } from "./helpers/atom.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("GET /changelog.atom", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  const saved = process.env["FORGE_COMMIT"];

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = "a".repeat(40);
    dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-atom-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const insertIssue = app.db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', ?4, ?5, 'closed')`,
    );
    const insertPull = app.db.query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid) VALUES (?1, ?2, 'b', 'base', '', ?3, ?4)`,
    );
    insertIssue.run("i1", made.value.id, 1, "Fix <&> escaping", u.value.id);
    insertPull.run("i1", made.value.defaultBranch, "2026-10-01T10:00:00.000Z", "oid-live");
    insertIssue.run("i2", made.value.id, 2, "Not shipped yet", u.value.id);
    insertPull.run("i2", made.value.defaultBranch, "2026-10-02T10:00:00.000Z", "oid-new");
    keepLive("alice/forge", ["oid-live"], 0);
  }, 30_000);

  afterAll(async () => {
    forgetLive();
    if (saved === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = saved;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is valid Atom with the live landing escaped and the unshipped one left out", async () => {
    const res = await fetch(`${servers.url}/changelog.atom`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const text = await res.text();
    const { titles } = checkAtom(text, `${servers.url}/changelog.atom`);
    expect(titles).toEqual(["Went live: Fix <&> escaping"]);
    expect(text).toContain(`href="${servers.url}/alice/forge/pulls/1"`);
    expect(text).toContain("Fix &lt;&amp;&gt; escaping");
    expect(text).not.toContain("Not shipped yet");
  });

  test("caps the feed at the newest 30 entries", async () => {
    const insertIssue = app.db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) SELECT ?1, repo_id, ?2, 'pull', ?3, author_id, 'closed' FROM issue WHERE id = 'i1'`,
    );
    const insertPull = app.db.query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid) VALUES (?1, 'main', 'b', 'base', '', ?2, 'oid-live')`,
    );
    for (let n = 10; n < 50; n++) {
      insertIssue.run(`bulk${n}`, n, `Bulk ${n}`);
      insertPull.run(`bulk${n}`, `2026-09-01T10:${String(n).padStart(2, "0")}:00.000Z`);
    }
    const text = await (await fetch(`${servers.url}/changelog.atom`)).text();
    expect(text.match(/<entry>/g)?.length).toBe(30);
    app.db.query(`DELETE FROM pull WHERE issue_id LIKE 'bulk%'`).run();
    app.db.query(`DELETE FROM issue WHERE id LIKE 'bulk%'`).run();
  });

  test("answers 304 to its ETag", async () => {
    const first = await fetch(`${servers.url}/changelog.atom`);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await fetch(`${servers.url}/changelog.atom`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  test("the page links it", async () => {
    const html = await (await fetch(`${servers.url}/changelog`)).text();
    expect(html).toMatch(/rel="alternate"\s+type="application\/atom\+xml"[^>]*href="\/changelog\.atom"/);
  });
});

describe("GET /changelog.atom on an empty forge", () => {
  test("says when the process started, not 1970, and the same twice", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-atom-empty-"));
    const app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    const servers = await serve(app);
    try {
      const get = async () => (await (await fetch(`${servers.url}/changelog.atom`)).text()).match(/<updated>([^<]*)<\/updated>/)![1]!;
      const first = await get();
      expect(first).not.toContain("1970-01-01");
      expect(Date.parse(first)).toBeGreaterThan(Date.parse("2026-01-01"));
      expect(await get()).toBe(first);
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
