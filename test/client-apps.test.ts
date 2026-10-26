/** What a client's apps are doing: the work running, else what was last finished (#4007, #6091). */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { clientDoings, clientFinished, doingLine, finishedLine } from "../src/core/client-apps.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

const NOW = new Date("2026-10-21T12:00:00.000Z");
let db: Database;

beforeEach(() => {
  db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u','u','u@x','x')");
  for (const r of ["a", "b", "c", "d", "e"]) {
    db.run("INSERT INTO repo (id, owner_id, name) VALUES (?, 'u', ?)", [r, r]);
  }
});

let n = 0;
function issue(repo: string, title: string, kind = "issue"): string {
  const id = `i${++n}`;
  db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?, ?, ?, ?, ?, 'u', ?)", [id, repo, n, kind, title, kind === "pull" ? "closed" : "open"]);
  return id;
}
function landed(repo: string, title: string, at: string): void {
  const id = issue(repo, title, "pull");
  db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?, 'main', 'h', 'o', 'o', ?)", [id, at]);
}
function running(repo: string, issueId: string | null): void {
  db.run("INSERT INTO run (id, repo_id, kind, state, issue_id) VALUES (?, ?, 'agent', 'running', ?)", [`r${++n}`, repo, issueId]);
}

describe("clientDoings", () => {
  test("a running run names its issue", () => {
    running("a", issue("a", "Add a contact form"));
    expect(clientDoings(db, ["a"]).get("a")).toEqual({ title: "Add a contact form" });
  });

  test("a change that landed is not work in progress", () => {
    landed("a", "Fix the footer", "2026-10-20T10:00:00.000Z");
    expect(clientDoings(db, ["a"]).size).toBe(0);
  });

  test("a running run with no issue yields nothing", () => {
    running("a", null);
    expect(clientDoings(db, ["a"]).size).toBe(0);
  });

  test("a quiet app, an unlisted app and no apps yield nothing; apps are kept apart", () => {
    running("b", issue("b", "Mine"));
    running("c", issue("c", "Not asked"));
    expect([...clientDoings(db, ["a", "b"]).keys()]).toEqual(["b"]);
    expect(clientDoings(db, []).size).toBe(0);
  });
});

describe("clientFinished", () => {
  test("the newest merged pull wins, however old", () => {
    landed("a", "First", "2025-01-16T10:00:00.000Z");
    landed("a", "Second", "2025-02-18T10:00:00.000Z");
    expect(clientFinished(db, ["a"]).get("a")).toEqual({ title: "Second", at: "2025-02-18T10:00:00.000Z" });
  });

  test("a quiet app, an unlisted app and no apps yield nothing", () => {
    landed("b", "Mine", "2026-10-20T10:00:00.000Z");
    landed("c", "Not asked", "2026-10-20T10:00:00.000Z");
    expect([...clientFinished(db, ["a", "b"]).keys()]).toEqual(["b"]);
    expect(clientFinished(db, []).size).toBe(0);
  });
});

describe("the lines", () => {
  test("finishedLine spells the age out and is empty with nothing finished", () => {
    const at = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    expect(finishedLine({ title: "Fix the menu", at }, NOW.getTime())).toBe("Finished 3 days ago: Fix the menu");
    expect(finishedLine(undefined, NOW.getTime())).toBe("");
  });

  test("doingLine says Working on, or nothing", () => {
    expect(doingLine({ title: "Add rye" })).toBe("Working on: Add rye");
    expect(doingLine(undefined)).toBe("");
  });
});
