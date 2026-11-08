import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { applyLabelNames, importLabels } from "../src/origins/import.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * Labels from an origin are matched by name (case-insensitively, as the
 * module's queries do): a re-sync neither duplicates a label nor keeps one
 * the origin took off an issue.
 */

let dir: string;
let app: App;
let repoId: string;
let authorId: string;

const rows = () =>
  app.db
    .query<{ name: string }, [string]>(
      "SELECT name FROM label WHERE repo_id = ?1 ORDER BY name",
    )
    .all(repoId)
    .map((r) => r.name);

const attached = (issueId: string) =>
  app.db
    .query<{ name: string }, [string]>(
      `SELECT l.name FROM issue_label il JOIN label l ON l.id = il.label_id
       WHERE il.issue_id = ?1 ORDER BY l.name`,
    )
    .all(issueId)
    .map((r) => r.name);

const newIssue = (title: string) => {
  const made = createIssue(app.db, { repoId, authorId, title });
  if (!made.ok) throw new Error(made.error);
  return made.value.id;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-origin-labels-"));
  app = createApp({ dataDir: dir, port: 0 });
  const admin = await seedAdmin(app, {
    username: "alice",
    email: "alice@forge.test",
    password: "alice-login-secret",
  });
  if (!admin.ok) throw new Error(admin.error);
  authorId = admin.value.id;
  const repo = await createRepo(app, admin.value, { name: "yard", visibility: "private" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("importLabels", () => {
  test("importing the same labels twice leaves one row per name", () => {
    const remote = [
      { remoteId: "1", name: "bug", color: "d73a4a" },
      { remoteId: "2", name: "docs", color: "0075ca" },
    ];
    importLabels(app.db, repoId, remote);
    importLabels(app.db, repoId, remote);
    expect(rows()).toEqual(["bug", "docs"]);
  });

  test("a re-sync adopts the row by name, case-insensitively, and takes the new colour", () => {
    importLabels(app.db, repoId, [{ remoteId: "9", name: "BUG", color: "000000" }]);
    expect(rows()).toEqual(["bug", "docs"]);
    const bug = app.db
      .query<{ color: string; origin_remote_id: string }, []>(
        "SELECT color, origin_remote_id FROM label WHERE name = 'bug'",
      )
      .get();
    expect(bug).toEqual({ color: "000000", origin_remote_id: "9" });
  });

  test("a name blank after trimming is skipped", () => {
    const before = rows();
    const out = importLabels(app.db, repoId, [
      { remoteId: "7", name: "", color: "ffffff" },
      { remoteId: "8", name: "   \t ", color: "ffffff" },
    ]);
    expect(out.size).toBe(0);
    expect(rows()).toEqual(before);
  });
});

describe("applyLabelNames", () => {
  test("[a, b] then [b] leaves the issue with only b", () => {
    const issueId = newIssue("labelled");
    applyLabelNames(app.db, repoId, issueId, ["a", "b"]);
    expect(attached(issueId)).toEqual(["a", "b"]);
    applyLabelNames(app.db, repoId, issueId, ["b"]);
    expect(attached(issueId)).toEqual(["b"]);
  });

  test("each name is made once, however often it is applied", () => {
    const issueId = newIssue("again");
    applyLabelNames(app.db, repoId, issueId, ["fresh", "fresh"]);
    applyLabelNames(app.db, repoId, issueId, ["fresh"]);
    expect(rows().filter((n) => n === "fresh")).toHaveLength(1);
    expect(attached(issueId)).toEqual(["fresh"]);
  });

  test("a name blank after trimming is skipped, and the rest are trimmed", () => {
    const issueId = newIssue("blanks");
    const before = rows().length;
    applyLabelNames(app.db, repoId, issueId, ["", "  ", " padded "]);
    expect(attached(issueId)).toEqual(["padded"]);
    expect(rows().length).toBe(before + 1);
  });
});
