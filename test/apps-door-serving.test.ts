import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { doorPage } from "../src/apps/door.ts";
import { readServing } from "../src/apps/serving.ts";

const db = new Database(":memory:");
db.run(`CREATE TABLE run (id INTEGER PRIMARY KEY, repo_id TEXT, kind TEXT, env TEXT, commit_oid TEXT, serving_at TEXT)`);
const deploy = (env: string, sha: string, at: string | null) =>
  db.run(`INSERT INTO run (repo_id, kind, env, commit_oid, serving_at) VALUES ('r1','deploy',?,?,?)`, [env, sha, at]);

const page = async (repoId: string, env: string) => {
  const where = { app: "notes", env, repo: "me/notes", ...(env === "production" ? {} : { pull: 7 }) };
  const res = doorPage(
    { where, forgeUrl: "https://forge.test", serving: readServing(db, repoId, env) },
    false,
  );
  return { res, html: await res.text() };
};

test("production shows the newest release and the three before it, linked", async () => {
  for (const [i, c] of ["a", "b", "c", "d", "e"].entries())
    deploy("production", c.repeat(40), `2026-10-0${i + 1}T10:00:00.000Z`);
  deploy("production", "f".repeat(40), null);
  const { html } = await page("r1", "production");
  expect(html).toContain("Serving <a href=\"https://forge.test/me/notes/commit/" + "e".repeat(40));
  expect(html).toContain("since <time datetime=\"2026-10-05T10:00:00.000Z\">2026-10-05 10:00 UTC");
  for (const c of ["d", "c", "b"]) expect(html).toContain(`/commit/${c.repeat(40)}`);
  expect(html).not.toContain("a".repeat(40));
  expect(html).not.toContain("f".repeat(7));
});

test("a preview shows its pull and short sha", async () => {
  deploy("pull-7", "1234567890abcdef".repeat(2) + "12345678", "2026-10-06T08:30:00.000Z");
  const { html } = await page("r1", "pull-7");
  expect(html).toContain("Preview of #7 at ");
  expect(html).toContain("<code>1234567</code>");
  expect(html).toContain(", deployed <time");
  expect(html).not.toContain("Serving");
});

test("an app never released says so", async () => {
  const { html } = await page("none", "production");
  expect(html).toContain("not released yet");
});

test("a guest, whose page names no repository, sees no sha and no history", async () => {
  const guest = (where: { app: string; env: string; pull?: number }, serving = readServing(db, "r1", where.env)) =>
    doorPage({ where, forgeUrl: "https://forge.test", serving }, false).text();
  const prod = await guest({ app: "notes", env: "production" });
  expect(prod).toContain("Serving since <time");
  expect(prod).not.toMatch(/<code>|\/commit\/|Before it/);
  for (const c of "abcde") expect(prod).not.toContain(c.repeat(7));
  const prev = await guest({ app: "notes", env: "pull-7", pull: 7 });
  expect(prev).toContain("Preview of #7, deployed <time");
  expect(prev).not.toMatch(/<code>|1234567/);
});

test("a commit deployed twice is one release, and the fourth older one still shows", async () => {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE run (id INTEGER PRIMARY KEY, repo_id TEXT, kind TEXT, env TEXT, commit_oid TEXT, serving_at TEXT)`);
  const put = (sha: string, at: string) =>
    d.run(`INSERT INTO run (repo_id, kind, env, commit_oid, serving_at) VALUES ('r2','deploy','production',?,?)`, [sha, at]);
  put("a".repeat(40), "2026-10-01T10:00:00.000Z");
  put("b".repeat(40), "2026-10-02T10:00:00.000Z");
  put("c".repeat(40), "2026-10-03T10:00:00.000Z");
  put("d".repeat(40), "2026-10-04T10:00:00.000Z");
  put("d".repeat(40), "2026-10-05T10:00:00.000Z");
  const s = readServing(d, "r2", "production");
  expect(s).toEqual({
    kind: "production",
    releases: [
      { sha: "d".repeat(40), at: "2026-10-05T10:00:00.000Z" },
      { sha: "c".repeat(40), at: "2026-10-03T10:00:00.000Z" },
      { sha: "b".repeat(40), at: "2026-10-02T10:00:00.000Z" },
      { sha: "a".repeat(40), at: "2026-10-01T10:00:00.000Z" },
    ],
  });
});

test("a preview with no deploy says so", async () => {
  const s = readServing(db, "r1", "pull-99");
  expect(s).toEqual({ kind: "preview", pull: 99 });
  const html = await doorPage(
    { where: { app: "notes", env: "pull-99", repo: "me/notes", pull: 99 }, forgeUrl: "https://forge.test", serving: s },
    false,
  ).text();
  expect(html).toContain("Preview of #99, not deployed yet");
});
