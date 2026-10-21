/** The API's read of one issue names its Server-Timing phases, found or not. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { addComment, getIssue } from "../src/core/issues.ts";

let f: SnappyFixture;

beforeAll(async () => {
  f = await snappyFixture({ repos: 1, issuesPerRepo: 4 });
  const repo = f.repos[0]!;
  const issue = getIssue(f.app.db, repo.id, 2)!;
  addComment(f.app.db, { issueId: issue.id, authorId: f.owner.id, body: "first" });
}, 120_000);
afterAll(async () => {
  await f.close();
});

async function read(n: number) {
  const repo = f.repos[0]!;
  const res = await fetch(`${f.base}/api/v1/repos/${repo.ownerName}/${repo.name}/issues/${n}`, {
    headers: { cookie: f.ownerCookie },
  });
  const body = (await res.json()) as { comments: unknown[] };
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]);
  return { res, body, names };
}

test("an issue with comments names session, issue, comments, labels and render", async () => {
  const { res, body, names } = await read(2);
  expect(res.status).toBe(200);
  for (const n of ["session", "issue", "comments", "labels", "render"]) expect(names).toContain(n);
  expect(body.comments.length).toBe(1);
});

test("a missing issue still names session and issue", async () => {
  const { res, names } = await read(99);
  expect(res.status).toBe(404);
  expect(names).toContain("session");
  expect(names).toContain("issue");
  expect(names).not.toContain("render");
});
