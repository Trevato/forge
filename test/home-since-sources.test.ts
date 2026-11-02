/**
 * #6712: the digest reads the viewer's readable repositories (`canRead`), and
 * releases and red gates make lines beside landed pulls, three at most.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { digest } from "../src/feed/digest.ts";
import { eventsSince, sinceDigest } from "../src/web/studio/since.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

const H = 3600 * 1000;
let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

const iso = (ago: number): string => new Date(Date.now() - ago).toISOString();
let n = 0;
function land(repoId: string, ago: number): void {
  const id = `src-${n}`;
  db().query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?1, ?2, ?3, 'pull', 't', ?4)").run(id, repoId, 7000 + n++, f.owner.id);
  db().query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', 'h', 'a', 'b', ?2)").run(id, iso(ago));
}
const db = () => f.app.db;
const notes = () => db().query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'notes'").get()!.id;

test("a member sees a private repository's landed pull; a stranger does not", () => {
  land(notes(), H);
  const mine = eventsSince(db(), f.peer, Date.now() - 3 * H, Date.now());
  expect(mine.map((e) => e.repo)).toEqual(["pablo/notes"]);
  expect(eventsSince(db(), undefined, Date.now() - 3 * H, Date.now())).toHaveLength(0);
});

test("a release and a red gate in the window each make a line; green and old ones do not", () => {
  const repo = f.repos.find((r) => r.visibility === "public")!;
  db().query("INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at) VALUES ('abc1234', ?1, 1, 1, 'ok', ?2)").run(repo.id, iso(H));
  const gate = (id: string, state: string, ago: number): void => {
    db()
      .query("INSERT INTO gate_result (id, repo_id, run_id, tip_oid, state, started_at, finished_at) VALUES (?1, ?2, 'r', 't', ?3, ?4, ?4)")
      .run(id, repo.id, state, iso(ago));
  };
  gate("g-red", "red", H);
  gate("g-green", "green", H);
  gate("g-old", "red", 9 * 24 * H);
  const events = eventsSince(db(), f.peer, Date.now() - 3 * H, Date.now()).filter((e) => e.repo === `${repo.ownerName}/${repo.name}`);
  expect(events.map((e) => e.kind).sort()).toEqual(["failed", "released"]);
  const d = sinceDigest(db(), f.peer, Date.now() - 2 * H, Date.now())!;
  const line = d.lines.find((l) => l.repo === `${repo.ownerName}/${repo.name}`)!;
  expect(line.says).toContain("1 released");
  expect(line.says).toContain("1 failed");
  expect(line.href).toBe(`/${repo.ownerName}/${repo.name}/pulls`);
  expect(line.href).not.toContain("/api/");
});

test("a fourth source is cut at three, biggest first", () => {
  const now = Date.now();
  const ev = (repo: string, weight: number) => ({ repo, kind: "landed" as const, at: now - H, href: `/${repo}`, weight });
  const lines = digest([ev("a/a", 1), ev("b/b", 4), ev("c/c", 2), ev("d/d", 3)], now);
  expect(lines.map((l) => l.repo)).toEqual(["b/b", "d/d", "c/c"]);
});

test("release and failed lines link to readable pages, the pull when known", () => {
  const repo = f.repos.find((r) => r.visibility === "public")!;
  db().query("INSERT INTO gate_result (id, repo_id, run_id, tip_oid, pulls, state, started_at, finished_at) VALUES ('g-pull', ?1, 'r', 't', '[42]', 'red', ?2, ?2)").run(repo.id, iso(H / 2));
  const hrefs = eventsSince(db(), f.peer, Date.now() - 3 * H, Date.now()).filter((e) => e.repo === `${repo.ownerName}/${repo.name}`).map((e) => e.href);
  expect(hrefs).toContain(`/${repo.ownerName}/${repo.name}/pulls/42`);
  expect(hrefs).toContain(`/${repo.ownerName}/${repo.name}/pulls/1`);
  expect(hrefs.some((h) => h.startsWith("/api/") || h === "/releases")).toBe(false);
});
