/** A repository's closed issues list answers fast with thousands of closed issues (#3386). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, setIssueState } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

const CLOSED = 3000;
let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-closed-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const repoId = made.value.id;
  const db = app.db;
  db.transaction(() => {
    for (let i = 1; i <= CLOSED; i++) {
      const issue = createIssue(db, { repoId, authorId: admin.value.id, title: `issue ${i}` });
      if (!issue.ok) throw new Error(String(issue.error));
      // A busy repository's other events sit between the closings.
      for (let k = 0; k < 20; k++) app.bus.append({ kind: "issue.commented", repoId, payload: { number: issue.value.number, k } });
      setIssueState(db, issue.value.id, "closed");
      if (i % 2 !== 0) {
        app.bus.append({ kind: "issue.closed", repoId, payload: { number: issue.value.number, reason: "done" } });
        continue;
      }
      // Even ones were closed by a merged pull, as `actions/pulls.ts` records it.
      const pull = createIssue(db, { repoId, authorId: admin.value.id, title: `pull ${i}`, kind: "pull" });
      if (!pull.ok) throw new Error(String(pull.error));
      db.query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at)
         VALUES (?1, 'main', ?2, 'a', 'b', ?3, ?4)`,
      ).run(pull.value.id, `b${i}`, repoId, new Date().toISOString());
      setIssueState(db, pull.value.id, "closed");
      app.bus.append({ kind: "issue.closed", repoId, payload: { number: issue.value.number, by: "merge", pull: pull.value.number } });
    }
  })();
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async () => {
  const res = await fetch(`${servers.url}/alice/notes/issues?state=closed`);
  return { res, text: await res.text() };
};

test("the closed list answers well inside a second with 3,000 closed issues", async () => {
  await get();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const { res } = await get();
    times.push(performance.now() - t);
    expect(res.status).toBe(200);
  }
  times.sort((a, b) => a - b);
  // The median stays far above the ~20 ms it takes, and far below the seconds a per-row scan took.
  expect(times[2]!).toBeLessThan(1_000);
});

test("the closed list shows the newest page in order, each row worded by how it closed", async () => {
  const { text } = await get();
  const rows = [...text.matchAll(/>issue (\d+)</g)].map((m) => Number(m[1]));
  const shown = [...new Set(rows)];
  expect(shown.length).toBeGreaterThan(20);
  expect(shown).toEqual([...shown].sort((a, b) => b - a));
  // Issues are numbered with their pulls between them: the newest is 3000's.
  expect(shown[0]).toBe(CLOSED);
  // Odd ones were closed by hand, even ones by a merged pull.
  expect(text.match(/aria-label="[^"]*closed as done/g)?.length).toBe(shown.filter((n) => n % 2 === 1).length);
  expect(text.match(/aria-label="shipped — merged"/g)?.length).toBe(shown.filter((n) => n % 2 === 0).length);
});
