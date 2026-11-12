/**
 * A list route given a cursor or state it cannot read answers 422 (#8504):
 * an agent paging with a mangled cursor is stopped, not handed page one again.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("list cursors and states are validated", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let headers: Record<string, string>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-list-cursor-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    headers = { authorization: `Bearer ${createToken(app.db, made.value.id, "t", "admin").token}` };
    const lib = await createRepo(app, made.value, { name: "lib", visibility: "public" });
    if (!lib.ok) throw new Error(String(lib.error));
    for (let n = 1; n <= 5; n++) {
      createIssue(app.db, { repoId: lib.value.id, authorId: made.value.id, title: `issue ${n}` });
      const pull = createIssue(app.db, {
        repoId: lib.value.id,
        authorId: made.value.id,
        title: `pull ${n}`,
        kind: "pull",
      });
      if (!pull.ok) throw new Error(String(pull.error));
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
        )
        .run(pull.value.id, `topic-${n}`, lib.value.id);
      const more = await createRepo(app, made.value, { name: `r${n}`, visibility: "public" });
      if (!more.ok) throw new Error(String(more.error));
    }
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(`${servers.url}/api/v1${path}`, { headers });

  test("issue and pull lists refuse a cursor that is not a positive integer", async () => {
    for (const route of ["/repos/alice/lib/issues", "/repos/alice/lib/pulls"])
      for (const bad of ["abc", "0", "-1", "1.5", "", "1e3", "%25%25"]) {
        const res = await get(`${route}?cursor=${bad}`);
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({
          error: "invalid_cursor",
          message: "cursor is the next_cursor of a previous page",
        });
      }
  });

  test("issue and pull lists refuse a state other than open, closed or all", async () => {
    for (const route of ["/repos/alice/lib/issues", "/repos/alice/lib/pulls"]) {
      for (const bad of ["bogus", "Closed", "", "OPEN"]) {
        const res = await get(`${route}?state=${bad}`);
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ error: "invalid_state", message: "state is open, closed or all" });
      }
      for (const ok of ["", "?state=open", "?state=closed", "?state=all"])
        expect((await get(`${route}${ok}`)).status).toBe(200);
    }
  });

  test("repository lists refuse a cursor outside the id alphabet", async () => {
    for (const route of ["/repos", "/users/alice/repos"])
      for (const bad of ["%25%25", "a.b", "", "a".repeat(65), "a%20b"]) {
        const res = await get(`${route}?cursor=${bad}`);
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({
          error: "invalid_cursor",
          message: "cursor is the next_cursor of a previous page",
        });
      }
  });

  test("following next_cursor walks every page of each list", async () => {
    for (const [route, total] of [
      ["/repos/alice/lib/issues", 5],
      ["/repos/alice/lib/pulls", 5],
      ["/repos", 6],
    ] as const) {
      const seen: unknown[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(`${route}?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { id: string }[]; next_cursor: string | number | null };
        seen.push(...body.items.map((i) => i.id));
        cursor = body.next_cursor === null ? null : String(body.next_cursor);
        pages++;
      } while (cursor !== null && pages < 10);
      expect(pages).toBeGreaterThanOrEqual(Math.ceil(total / 2));
      expect(pages).toBeLessThan(10);
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    }
  });
});
