/** A thread of 200 comments renders no comment body at read time (the memo counters, with a loose 250 ms guard), and renders the same HTML it always did (#3324). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { listEvents } from "../src/core/events.ts";
import { markdownMemoStats, renderMarkdown } from "../src/web/markdown.ts";
import { seedBody } from "./thread-seed.ts";

let f: SnappyFixture;
let path = "";

beforeAll(async () => {
  f = await snappyFixture({ repos: 1, issuesPerRepo: 1 });
  const repo = f.repos[0]!;
  const opened = openIssue(f.app, f.owner, repo, {
    title: "The direction thread",
    body: seedBody(-1),
  });
  if (!opened.ok) throw new Error(String(opened.error));
  for (let i = 0; i < 200; i++) {
    const added = addComment(f.app, f.owner, repo, opened.value, seedBody(i));
    if (!added.ok) throw new Error(String(added.error));
  }
  path = `/${repo.ownerName}/${repo.name}/issues/${opened.value.number}`;
}, 120_000);
afterAll(async () => {
  await f.close();
});

async function view(): Promise<{ ms: number; html: string }> {
  const res = await fetch(`${f.base}${path}?all=1`, { headers: { cookie: f.ownerCookie } });
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text.match(/data-comment-id="/g)?.length).toBeGreaterThanOrEqual(200);
  const m = /render;dur=(\d+\.\d)/.exec(res.headers.get("server-timing") ?? "");
  return { ms: Number(m![1]), html: text };
}

test("the first view of a 200-comment thread renders no comment body: the writes already did", async () => {
  // A server that has served a page before, so only the thread is in question.
  const repo = f.repos[0]!;
  await (await fetch(`${f.base}/${repo.ownerName}/${repo.name}/issues/1`, { headers: { cookie: f.ownerCookie } })).text();
  const before = markdownMemoStats();
  const first = await view();
  const after = markdownMemoStats();
  // Only the opening post, which is not rendered at write time, may miss.
  expect(after.misses - before.misses).toBeLessThanOrEqual(1);
  expect(after.hits - before.hits).toBeGreaterThanOrEqual(200);
  // Wall-clock is only a loose guard (the tight half is the counter above).
  expect(first.ms).toBeLessThan(250);
});

test("the seed renders the HTML it always did, cold and from the cache", async () => {
  const golden = (await Bun.file(`${import.meta.dir}/__snapshots__/thread-seed.html`).text()).split(
    "\n<!--next-->\n",
  );
  const seeds = [0, 1, 57, 128, 199];
  expect(golden.length).toBe(seeds.length);
  for (let pass = 0; pass < 2; pass++) {
    seeds.forEach((n, k) => expect(renderMarkdown(seedBody(n)).text).toBe(golden[k]!));
  }
});

test("markdown stays escaped through the fast paths", () => {
  expect(renderMarkdown("<script>alert(1)</script> [x](javascript:alert(1))").text).toBe(
    "<p>&lt;script&gt;alert(1)&lt;/script&gt; [x](javascript:alert(1))</p>",
  );
  expect(renderMarkdown("plain words").text).toBe("<p>plain words</p>");
});

test("listEvents with kinds is the unfiltered window, filtered", () => {
  const repoId = f.repos[0]!.id;
  for (const limit of [3, 50, 500]) {
    const all = listEvents(f.app.db, { repoId, limit });
    for (const kinds of [["issue.commented"], ["issue.commented", "issue.opened"], ["nothing.here"], []]) {
      const want = all.filter((e) => kinds.includes(e.kind));
      expect(listEvents(f.app.db, { repoId, limit, kinds }).map((e) => e.id)).toEqual(want.map((e) => e.id));
    }
  }
  expect(listEvents(f.app.db, { repoId, limit: 500, kinds: ["issue.commented"] }).length).toBe(200);
});
