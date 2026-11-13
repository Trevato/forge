/** /next narrows to one pillar or a word, keeping the owner's order and real numbers (#11867). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { rankIssue } from "../src/actions/next.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { filterPath, markBefore, matches, readFilter } from "../src/web/pages/next_filter.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
const nums: Record<string, number> = {};
let alice: Parameters<typeof rankIssue>[1];
let repo: Parameters<typeof rankIssue>[2];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-next-filter-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const r = await createRepo(app, alice, { name: "filt", visibility: "public" });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  repo = r.value;
  const open = (title: string): number => {
    const o = openIssue(app, alice, repo, { title });
    if (!o.ok) throw new Error(String(o.error));
    nums[title] = o.value.number;
    return o.value.number;
  };
  const dep = (a: number, b: number) =>
    app.db.run("INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES ((SELECT id FROM issue WHERE repo_id=?1 AND number=?2),(SELECT id FROM issue WHERE repo_id=?1 AND number=?3))", [repo.id, a, b]);
  const u7 = open("P7 Speed: be quick");
  const u1 = open("P1 Trust: be safe");
  const titles = ["alpha cache", "beta cache", "gamma safe", "delta cache", "epsilon"];
  const made5 = titles.map(open);
  dep(u7, made5[0]!);
  dep(u7, made5[1]!);
  dep(u1, made5[2]!);
  dep(u7, made5[3]!);
  dep(u1, made5[4]!);
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (qs: string) => {
  const res = await fetch(`${servers.url}/alice/filt/next${qs}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
};
const numbersOf = (page: string) => [...page.matchAll(/<li[^>]*data-number="(\d+)"/g)].map((m) => Number(m[1]));

test("a word keeps the owner's order and the real numbers, and counts in words", async () => {
  const all = numbersOf((await get("")).text);
  const page = (await get("?q=CACHE")).text;
  const shown = numbersOf(page);
  const want = [nums["alpha cache"]!, nums["beta cache"]!, nums["delta cache"]!];
  expect(shown).toEqual(all.filter((n) => want.includes(n)));
  expect(shown.length).toBe(3);
  expect(page).toContain(`3 of ${all.length} shown`);
  // What was typed is kept for the input; only matching ignores case.
  expect(page).toContain('value="CACHE"');
  expect(page).toContain("capacity bar is left out while filtered");
  // Rank numbers are the full ranking's, not 1, 2, 3.
  for (const n of shown) expect(page).toContain(`>${all.indexOf(n) + 1}<`);
});

test("a pillar shows only what serves it", async () => {
  const page = (await get("?pillar=P1")).text;
  expect(numbersOf(page).sort()).toEqual([nums["gamma safe"]!, nums["epsilon"]!].sort());
  expect(page).toContain("2 of");
});

test("a move under a filter carries the filter back and moves in the full ranking", async () => {
  const page = (await get("?q=cache&pillar=P7")).text;
  const forms = [...page.matchAll(/name="back" value="([^"]*)"/g)].map((m) => m[1]);
  expect(forms.length).toBeGreaterThan(0);
  for (const f of forms) expect(f).toBe("/alice/filt/next?pillar=P7&amp;q=cache");
  const before = numbersOf((await get("")).text);
  const target = nums["delta cache"]!;
  const res = await fetch(`${servers.url}/alice/filt/next`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ number: String(target), to: "top", back: "/alice/filt/next?pillar=P7&q=cache" }),
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("/alice/filt/next?pillar=P7&q=cache");
  const after = numbersOf((await get("")).text);
  expect(after[0]).toBe(target);
  expect(after.length).toBe(before.length);
});

test("bad input is bounded and escaped; an unknown pillar is an empty list, not an error", async () => {
  const unknown = await get("?pillar=P99");
  expect(unknown.status).toBe(200);
  expect(numbersOf(unknown.text)).toEqual([]);
  expect(unknown.text).toContain("no pillar P99");
  const bad = await get("?pillar=%3Cscript%3E");
  expect(bad.status).toBe(200);
  expect(bad.text).not.toContain("<script>alert");
  expect(numbersOf(bad.text)).toEqual([]);
  const xss = await get(`?q=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
  expect(xss.status).toBe(200);
  expect(xss.text).not.toContain("<img src=x");
  expect(readFilter(new URLSearchParams({ q: "x".repeat(200) })).q.length).toBe(80);
  expect(readFilter(new URLSearchParams({ q: "CaChe" })).q).toBe("CaChe");
  expect(matches(readFilter(new URLSearchParams({ q: "CaChe" })), "a cache", undefined)).toBe(true);
  expect(matches(readFilter(new URLSearchParams("pillar=Later")), "t", "P1 Trust")).toBe(false);
  expect(filterPath("/b", readFilter(new URLSearchParams("")), "")).toBe("/b");
});

test("the cut line stays at the whole ranking's place: before the first shown row past it, never at an edge", () => {
  expect(markBefore([0, 3, 7, 9], 5)).toBe(2);
  expect(markBefore([6, 7], 5)).toBe(-1); // every shown row is under it: no line to draw above them
  expect(markBefore([0, 1], 5)).toBe(-1); // every shown row fits: no line below them
  expect(markBefore([], 5)).toBe(-1);
});
