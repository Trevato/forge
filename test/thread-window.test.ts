/** A long thread shows its opening post and newest 50 items; `?all=1` shows everything (#6124). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { addComment, openIssue, setIssueState } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";

import { commentAnchor, getIssue, listComments } from "../src/core/issues.ts";
import { candidatesFor } from "../src/feed/items.ts";

let f: SnappyFixture;
let path = "";
let ids: string[] = [];
let issue: NonNullable<ReturnType<typeof getIssue>>;

beforeAll(async () => {
  f = await snappyFixture({ repos: 1, issuesPerRepo: 1 });
  const repo = f.repos[0]!;
  const opened = openIssue(f.app, f.owner, repo, { title: "Long", body: "opening post" });
  if (!opened.ok) throw new Error(String(opened.error));
  issue = opened.value;
  for (let i = 0; i < 300; i++) {
    const added = addComment(f.app, f.owner, repo, opened.value, `comment number ${i}`);
    if (!added.ok) throw new Error(String(added.error));
  }
  ids = listComments(f.app.db, issue.id, { kind: "comment" }).map((c) => c.id);
  path = `/${repo.ownerName}/${repo.name}/issues/${opened.value.number}`;
}, 120_000);
afterAll(async () => {
  await f.close();
});

const get = async (suffix = ""): Promise<string> =>
  (await fetch(`${f.base}${path}${suffix}`, { headers: { cookie: f.ownerCookie } })).text();
const count = (html: string): number => html.match(/class="tl-item" id="c-/g)?.length ?? 0;

test("the default page has the newest 50, a link naming the 250 earlier, and stays small", async () => {
  const html = await get();
  expect(count(html)).toBe(50);
  expect(html).toContain("comment number 299");
  expect(html).not.toContain("comment number 249<");
  expect(html).toContain(`href="${path}?all=1"`);
  expect(html).toContain("Show 250 earlier items");
  expect(html).toContain("opening post");
  expect(new TextEncoder().encode(html).length).toBeLessThan(250 * 1024);
});

test("?all=1 has all 300 and no link", async () => {
  const html = await get("?all=1");
  expect(count(html)).toBe(300);
  expect(html).not.toContain("earlier</a>");
});

test("a comment's anchor lands: hidden ones go through ?all=1", () => {
  const db = f.app.db;
  expect(commentAnchor(db, issue.id, ids[0]!)).toBe(`?all=1#c-${ids[0]}`);
  expect(commentAnchor(db, issue.id, ids[249]!)).toBe(`?all=1#c-${ids[249]}`);
  expect(commentAnchor(db, issue.id, ids[250]!)).toBe(`#c-${ids[250]}`);
  expect(commentAnchor(db, issue.id, ids[299]!)).toBe(`#c-${ids[299]}`);
});

test("the feed links a reply to its own comment, through ?all=1 when it is folded away", () => {
  const links = candidatesFor(f.app.db, f.owner, Date.now())
    .filter((c) => c.link?.startsWith(path))
    .map((c) => c.link);
  expect(links).toContain(`${path}?all=1#c-${ids[0]}`);
  expect(links).toContain(`${path}#c-${ids[299]}`);
});

test("the anchor id is in the page", async () => {
  expect(await get()).toContain(`id="c-${ids[299]}"`);
});

test("state lines among the newest comments do not move the edge: the anchor still lands", async () => {
  const repo = f.repos[0]!;
  const opened = openIssue(f.app, f.owner, repo, { title: "Edge", body: "edge" });
  if (!opened.ok) throw new Error(String(opened.error));
  const edge = opened.value;
  const said: string[] = [];
  for (let i = 0; i < 60; i++) {
    const added = addComment(f.app, f.owner, repo, edge, `edge comment ${i}`);
    if (!added.ok) throw new Error(String(added.error));
    said.push(added.value.id);
    // A close and a reopen after every fifth comment, so state lines sit between and after the edge.
    if (i % 5 === 4) {
      setIssueState(f.app, f.owner, repo, edge, "closed");
      setIssueState(f.app, f.owner, repo, edge, "open");
    }
  }
  const url = `${f.base}/${repo.ownerName}/${repo.name}/issues/${edge.number}`;
  const page = await (await fetch(url, { headers: { cookie: f.ownerCookie } })).text();
  const edgeId = said[10]!; // the 50th newest comment
  expect(commentAnchor(f.app.db, edge.id, edgeId)).toBe(`#c-${edgeId}`);
  expect(page).toContain(`id="c-${edgeId}"`);
  const folded = said[9]!;
  expect(commentAnchor(f.app.db, edge.id, folded)).toBe(`?all=1#c-${folded}`);
  expect(page).not.toContain(`id="c-${folded}"`);
  const all = await (await fetch(`${url}?all=1`, { headers: { cookie: f.ownerCookie } })).text();
  expect(all).toContain(`id="c-${folded}"`);
});

test("a pull thread windows too, and the link keeps the page's other query", async () => {
  const repo = f.repos[0]!;
  const seeded = await commitToBranch(f.app, f.owner, repo, {
    message: "seed",
    files: [{ path: "README.md", content: "hello\n" }],
  });
  expect(seeded.ok).toBe(true);
  const branched = await commitToBranch(f.app, f.owner, repo, {
    branch: "feature",
    message: "feature",
    files: [{ path: "feature.txt", content: "yes\n" }],
  });
  expect(branched.ok).toBe(true);
  const pull = await openPull(f.app, f.owner, repo, { title: "Feature", baseBranch: "main", headBranch: "feature" });
  if (!pull.ok) throw new Error(String(pull.error));
  for (let i = 0; i < 70; i++) {
    const added = addComment(f.app, f.owner, repo, pull.value, `pull comment ${i}`);
    if (!added.ok) throw new Error(String(added.error));
  }
  const url = `${f.base}/${repo.ownerName}/${repo.name}/pulls/${pull.value.number}`;
  const page = await (await fetch(`${url}?diff=0`, { headers: { cookie: f.ownerCookie } })).text();
  expect(page).toContain("Show 20 earlier items");
  expect(page).toContain(`href="/${repo.ownerName}/${repo.name}/pulls/${pull.value.number}?diff=0&amp;all=1"`);
  expect(page.match(/class="tl-item" id="c-/g)?.length).toBe(50);
  const all = await (await fetch(`${url}?diff=0&all=1`, { headers: { cookie: f.ownerCookie } })).text();
  expect(all.match(/class="tl-item" id="c-/g)?.length).toBe(70);
});
