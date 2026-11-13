/** /changelog groups releases under the chapter they closed (#11868); loose ones stay flat. */
import { expect, test } from "bun:test";
import type { Chapter } from "../src/core/chapters.ts";
import type { Landing, Landings } from "../src/release/landings.ts";
import { chapterEntries, chapterStamp, groupLandings, shippedRegion, type ChapterEntry } from "../src/web/pages/changelog.ts";
import { noteWords } from "../src/release/chapter_words.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { createApp } from "../src/app.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = new Date("2026-11-12T12:00:00Z");
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T10:00:00Z`;
const land = (number: number, at: string): Landing => ({ repo: "a/b", number, title: `Pull ${number}`, at, live: true });
const chapter = (name: string, opened: string, closed: string | null, over: Partial<Chapter> = {}): Chapter => ({
  id: name, repoId: "r", name, means: `${name} means done`, state: closed === null ? "open" : "closed", position: 1, patchOf: null,
  createdAt: opened, openedAt: opened, closedAt: closed, tagOid: closed === null ? null : "abc123", notes: `# ${name}\n\nShipped.\n`, costUsd: 1, ...over,
});
const entry = (c: Chapter, canSee = true): ChapterEntry => ({ repo: "a/b", chapter: c, canSee });

// Newest first: 30, 25 loose; 20, 15 in v2; 10 loose between; 5, 3 in v1; 1 before v1 opened.
const landings = [land(30, day(30)), land(25, day(25)), land(20, day(20)), land(15, day(15)), land(10, day(10)), land(5, day(5)), land(3, day(3)), land(1, day(1))];
const v1 = chapter("v1.0.0", day(2), day(6));
const v2 = chapter("v2.0.0", day(12), day(21));

test("two chapters and loose releases come out newest first with the right members", () => {
  const groups = groupLandings(landings, [entry(v1), entry(v2)], NOW);
  expect(groups.map((g) => (g.kind === "chapter" ? g.chapter.name : "loose"))).toEqual(["loose", "v2.0.0", "loose", "v1.0.0", "loose"]);
  expect(groups.map((g) => g.landings.map((l) => l.number))).toEqual([[30, 25], [20, 15], [10], [5, 3], [1]]);
});

test("a chapter with no release yet is not drawn, nor is one still open or closing after now", () => {
  const empty = chapter("v3.0.0", day(31), "2026-10-31T23:00:00Z");
  const later = chapter("v9.0.0", day(1), "2027-01-01T00:00:00Z");
  const groups = groupLandings(landings, [entry(empty), entry(later), entry(chapter("v4", day(1), null))], NOW);
  expect(groups).toEqual([{ kind: "loose", landings }]);
});

test("a chapter of a repository the reader may not see is not shown", () => {
  const groups = groupLandings(landings, [entry(v1, false), entry(v2)], NOW);
  expect(groups.flatMap((g) => (g.kind === "chapter" ? [g.chapter.name] : []))).toEqual(["v2.0.0"]);
});

const read = (live: Landing[]): Landings => ({ version: "1.0.0", commit: null, own: "a/b", live, onItsWay: [] });

test("the region draws the chapter as a row: plain words from the note, no markdown, escaped, each pull under its day", () => {
  const html = String(shippedRegion(read(landings), "a/b", NOW, "UTC", undefined, true, [entry(chapter("v2.0.0", day(12), day(21), { notes: "# v2\n\n**Shipped** the <b>x</b> thing. More later.\n" }))]));
  expect(html).toContain('data-chapter="v2.0.0"');
  expect(html).toContain("v2.0.0 means done");
  expect(html).toContain("Shipped the x thing.");
  expect(html).not.toContain("More later");
  expect(html).not.toContain("# v2");
  expect(html).not.toContain("**");
  expect(html).not.toContain("<pre");
  expect(html).not.toContain("<b>");
  // The dates stay: a day heading inside the chapter for each day its pulls landed.
  const inside = html.slice(html.indexOf('data-chapter="v2.0.0"'));
  expect(inside).toContain('data-day="2026-10-20"');
  expect(inside).toContain('data-day="2026-10-15"');
  expect(String(shippedRegion(read(landings), "a/b", NOW))).not.toContain("data-chapter");
});

test("noteWords keeps the first sentence as plain words", () => {
  expect(noteWords("# Title\n\n- **Fast** [docs](http://x) and `code`. Second.")).toBe("Fast docs and code.");
  expect(noteWords("# only a heading\n")).toBe("");
  expect(noteWords("x".repeat(500)).length).toBeLessThanOrEqual(200);
});

test("chapterStamp moves when a chapter closes and is the same otherwise", async () => {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-chap-")), port: 0 });
  try {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "own", email: "o@f.dev", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "r", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const repo = getRepo(app.db, "own", "r")!;
    const before = chapterStamp(app.db);
    expect(chapterStamp(app.db)).toBe(before);
    closed(app, repo.id, "v1");
    expect(chapterStamp(app.db)).not.toBe(before);
  } finally {
    app.close();
  }
});

function closed(app: ReturnType<typeof createApp>, repoId: string, name: string): void {
  app.db
    .query(`INSERT INTO chapter (id, repo_id, name, means, state, position, created_at, opened_at, closed_at, tag_oid, notes) VALUES (?1, ?2, ?3, 'm', 'closed', 1, ?4, ?4, ?5, 'abc', 'Done.')`)
    .run(`c-${name}-${repoId}`, repoId, name, day(1), day(6));
}

test("a private repository's chapter is read by its owner and by no outsider", async () => {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-chap-")), port: 0 });
  try {
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: first });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const owner = await mk("own", true);
    const outsider = await mk("out");
    const made = await createRepo(app, owner, { name: "secret", visibility: "private" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const repo = getRepo(app.db, "own", "secret")!;
    closed(app, repo.id, "v1");
    const mine = [{ repo: "own/secret", number: 3, title: "Pull 3", at: day(4), live: true }];
    const seen = (u: typeof owner | undefined) => groupLandings(mine, chapterEntries(app.db, mine, u), NOW).filter((g) => g.kind === "chapter");
    expect(seen(owner).map((g) => (g.kind === "chapter" ? g.chapter.name : ""))).toEqual(["v1"]);
    expect(seen(outsider)).toEqual([]);
    expect(seen(undefined)).toEqual([]);
    // And in the page's words: the outsider's region has no chapter row.
    const region = (u: typeof owner | undefined) => String(shippedRegion({ version: "1", commit: null, own: "own/secret", live: mine, onItsWay: [] }, "own/secret", NOW, "UTC", undefined, true, chapterEntries(app.db, mine, u)));
    expect(region(owner)).toContain('data-chapter="v1"');
    expect(region(outsider)).not.toContain("data-chapter");
  } finally {
    app.close();
  }
});
