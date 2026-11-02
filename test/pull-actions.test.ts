/** The pull page at rest (#8773): status as a dot, the check as one line, the rare actions folded into "More" — and every action it ever offered still on the page or in the palette. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { pullRoster, type PullRosterInput } from "../src/web/studio/pull_roster.ts";

let f: SnappyFixture;
let base = "";
let number = 0;
beforeAll(async () => {
  f = await snappyFixture({ repos: 1, issuesPerRepo: 2 });
  const repo = f.repos[0]!;
  base = `/${repo.ownerName}/${repo.name}`;
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(f.app, f.owner, repo, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const made = await openPull(f.app, f.owner, repo, {
    title: "A change",
    body: "Body",
    headBranch: "topic",
    baseBranch: "main",
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  number = made.value.number;
}, 120_000);
afterAll(async () => {
  await f.close();
});

const get = async (path: string): Promise<string> =>
  await (await fetch(`${f.base}${base}${path}`, { headers: { cookie: f.ownerCookie } })).text();

test("the page wears a dot for its state, and has exactly one primary action", async () => {
  const text = await get(`/pulls/${number}`);
  expect(text).toMatch(/class="dot"[^>]*aria-label="[^"]+"/);
  expect(text).not.toMatch(/class="dot"[^>]*title=/);
  expect(text.match(/data-variant="primary"/g)?.length ?? 0).toBe(1); // Ship; Comment steps down
});

test("every action the page offered is still on it", async () => {
  const text = await get(`/pulls/${number}`);
  const at = `${base}/pulls/${number}`;
  for (const needle of [
    `href="${at}"`, // Conversation
    `href="${at}/files"`, // Files
    `action="${at}/ship"`, // merge
    `action="${at}/checks"`, // check again
    `action="${at}/hold"`, // hold
    `action="${at}/comments"`, // comment
    `action="${at}/state"`, // close
    `action="${at}/edit"`, // edit
    `href="${base}/branches"`, // branch
    `href="${base}/commits"`,
    `href="${base}/runs"`,
  ])
    expect(text).toContain(needle);
});

test("every action is in the palette", async () => {
  const text = await get(`/pulls/${number}`);
  const at = `${base}/pulls/${number}`;
  for (const h of [
    at,
    `${at}/files`,
    `${at}#decide`,
    `${at}#live-checks`,
    `${at}?more=1#hold`,
    `${at}#comment-body`,
    `${at}#edit`,
  ])
    expect(text).toContain(`"h":"${h}"`);
  for (const t of ["Ship", "Check again", "Hold", "Comment", "Close pull request", "Edit"])
    expect(text).toContain(`"t":"${t}","h":`);
});

test("the roster offers what the viewer may do and nothing else", () => {
  const o: PullRosterInput = {
    base: "/a/b", number: 7, headBranch: "t", crossRepo: false, signedIn: true, writer: true,
    state: "open", merged: false, mergeReady: false, labels: false, mayState: true,
  };
  const labels = (x: Partial<PullRosterInput>) => pullRoster({ ...o, ...x }).map((i) => i.t);
  const change = { shippable: true, conflicted: false, mayEdit: true, takeBack: false };
  const all = labels({ change });
  for (const w of ["Conversation", "Files", "Ship", "Check again", "Hold", "Comment", "Close pull request", "Edit"])
    expect(all).toContain(w);
  expect(all).not.toContain("Diff");
  expect(labels({ change: { ...change, conflicted: true } })).toContain("Bring up to date");
  const merged = labels({ state: "closed", merged: true, mayState: false, change: { ...change, shippable: false, mayEdit: false, takeBack: true } });
  expect(merged).toContain("Take it back");
  expect(merged).not.toContain("Ship");
  const reader = labels({ writer: false, mayState: false, change: { ...change, shippable: false, mayEdit: false } });
  expect(reader.length).toBeLessThanOrEqual(5);
});

const getAs = async (cookie: string, path: string): Promise<string> =>
  await (await fetch(`${f.base}${base}${path}`, { headers: { cookie } })).text();

test("the palette's Hold and Take it back land on an opened More, with no script", async () => {
  const at = `${base}/pulls/${number}`;
  const text = await get(`/pulls/${number}`);
  expect(text).toContain(`"h":"${at}?more=1#hold"`);
  const closed = await get(`/pulls/${number}`);
  expect(closed).toMatch(/<details[^>]*id="more"(?![^>]*\bopen\b)[^>]*>/);
  const opened = await get(`/pulls/${number}?more=1`);
  expect(opened).toMatch(/<details[^>]*id="more"[^>]*\bopen\b[^>]*>/);
  expect(opened).toContain("Hold this pull request");
  expect(opened).toContain('id="hold"');
});

test("a reader sees no private action, on the page or in the palette", async () => {
  const text = await getAs(f.peerCookie, `/pulls/${number}`);
  const at = `${base}/pulls/${number}`;
  for (const needle of [`action="${at}/ship"`, `action="${at}/hold"`, `action="${at}/checks"`, `action="${at}/edit"`, `id="more"`, "#hold", "#decide", "#edit"])
    expect(text).not.toContain(needle);
});

test("a merged pull offers Take it back on the page and in the palette, behind More", async () => {
  const repo = f.repos[0]!;
  const done = await commitToBranch(f.app, f.owner, repo, {
    branch: "topic2",
    message: "again",
    files: [{ path: "u.txt", content: "y" }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const made = await openPull(f.app, f.owner, repo, { title: "Second", body: "", headBranch: "topic2", baseBranch: "main" });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const merged = await mergePull(f.app, f.owner, repo, made.value, "squash");
  if (!merged.ok) throw new Error(JSON.stringify(merged.error));
  const n = made.value.number;
  const text = await get(`/pulls/${n}`);
  expect(text).toContain('id="take-back"');
  expect(text).toContain(`"h":"${base}/pulls/${n}?more=1#take-back"`);
  expect(text).toMatch(/<details[^>]*id="more"/);
  expect(await get(`/pulls/${n}?more=1`)).toMatch(/<details[^>]*id="more"[^>]*\bopen\b/);
  expect(await getAs(f.peerCookie, `/pulls/${n}`)).not.toContain("take-back");
});
