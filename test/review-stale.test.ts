/**
 * Home's "N waiting on you", /review and the MCP's `asks` count one set; asks
 * older than 30 days fold into "N stale, archive?" on all three.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo as createRepoRow } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { staleWords } from "../src/flow/kpi_words.ts";
import { serve } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { BULK_MAX } from "../src/actions/asks_bulk.ts";
import { splitStale, STALE_DAYS } from "../src/web/studio/review_set.ts";
import { staleArchive, staleLabel } from "../src/web/studio/review_stale.ts";

describe("splitStale", () => {
  test("30 days is the line; each side is newest first", () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    const { live, stale } = splitStale([{ since: at(29) }, { since: at(STALE_DAYS + 1) }, { since: at(2) }, { since: at(120) }], now);
    expect(live.map((a) => a.since)).toEqual([at(2), at(29)]);
    expect(stale.map((a) => a.since)).toEqual([at(31), at(120)]);
  });
  test("the label says when one step cannot take them all", () => {
    expect(staleLabel(3)).toBe("3 stale, archive?");
    expect(staleLabel(BULK_MAX + 1)).toBe(`First ${BULK_MAX} of ${BULK_MAX + 1} stale, archive?`);
    const form = staleArchive(Array.from({ length: BULK_MAX + 5 }, (_, i) => ({ id: `waiting:${i}` }))).toString();
    expect(form.match(/name="item"/g)?.length).toBe(BULK_MAX);
  });
  test("words", () => expect(staleWords(4)).toBe("4 stale, archive?"));
});

describe("one count on Home, /review and the MCP", () => {
  test("recent asks are counted, old ones fold, and the three agree", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-review-stale-"));
    const app = createApp({ dataDir: root, port: 0 });
    const servers = await serve(app);
    try {
      const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      const repo = await createRepoRow(app.db, app.reposRoot, { ownerId: made.value.id, name: "wait", visibility: "public", description: "wait" });
      if (!repo.ok) throw new Error(repo.error);
      [30, 40, 24 * 40, 24 * 120].forEach((h, i) => {
        const issueId = id();
        const number = app.db.query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq").get(repo.value.id)!.issue_seq;
        app.db
          .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`)
          .run(issueId, repo.value.id, number, `Ask ${i}`, made.value.id, new Date(Date.now() - h * 3_600_000).toISOString());
        app.db
          .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
          .run(issueId, `b/${i}`, "0".repeat(40), repo.value.id);
      });
      const signin = await fetch(`${servers.url}/signin`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      });
      const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
      const get = async (path: string) => await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

      const home = await get("/feed");
      const said = Number(/(\d+) waiting on you/.exec(home)?.[1]);
      expect(home).toContain("2 stale, archive?");
      expect(home).toContain('action="/asks/bulk"');
      expect(home).toContain('name="action" value="dismiss"');

      const review = await get("/review");
      const asks = (review.match(/<li[^>]* data-ask/g) ?? []).length;
      expect(review).toContain("2 stale, archive?");
      expect(review).toContain(">Review</h1>");
      // The admin's forge needs are not /review's rows, and the fold is not a list inside a list item.
      expect(review).not.toContain("The forge</span>");
      expect(review).not.toMatch(/<li[^>]*>(?:(?!<\/li>)[\s\S])*<ul class="row-children">(?:(?!<\/ul>)[\s\S])*<form method="post" action="\/asks\/bulk"/);

      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${createToken(app.db, made.value.id, "r", "ro").token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "asks", arguments: {} } }),
      });
      const mcp = JSON.parse(((await res.json()) as any).result.content[0].text);

      expect(said).toBe(2);
      expect(asks).toBe(said);
      expect(mcp.waiting).toEqual({ count: said, stale: 2 });
    } finally {
      await servers.stop();
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
