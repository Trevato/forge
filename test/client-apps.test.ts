/** What a client's apps are doing: the work running, else the last change landed this week (#4007). */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { clientDoings } from "../src/core/client-apps.ts";
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
    expect(clientDoings(db, ["a"], NOW).get("a")).toEqual({ kind: "working", title: "Add a contact form" });
  });

  test("a change landed inside the week is reported with when", () => {
    landed("a", "Fix the footer", "2026-10-15T13:00:00.000Z");
    expect(clientDoings(db, ["a"], NOW).get("a")).toEqual({ kind: "landed", title: "Fix the footer", at: "2026-10-15T13:00:00.000Z" });
  });

  test("a change landed more than 7 days ago is ignored", () => {
    landed("a", "Old", "2026-10-14T11:59:59.000Z");
    expect(clientDoings(db, ["a"], NOW).size).toBe(0);
  });

  test("the latest landed change wins", () => {
    landed("a", "First", "2026-10-16T10:00:00.000Z");
    landed("a", "Second", "2026-10-18T10:00:00.000Z");
    expect(clientDoings(db, ["a"], NOW).get("a")).toMatchObject({ title: "Second" });
  });

  test("working beats landed", () => {
    landed("a", "Done", "2026-10-20T10:00:00.000Z");
    running("a", issue("a", "Doing"));
    expect(clientDoings(db, ["a"], NOW).get("a")).toEqual({ kind: "working", title: "Doing" });
  });

  test("a running run with no issue yields nothing", () => {
    running("a", null);
    expect(clientDoings(db, ["a"], NOW).size).toBe(0);
  });

  test("a quiet app, an unlisted app and no apps yield nothing; apps are kept apart", () => {
    landed("b", "Mine", "2026-10-20T10:00:00.000Z");
    landed("c", "Not asked", "2026-10-20T10:00:00.000Z");
    const got = clientDoings(db, ["a", "b"], NOW);
    expect([...got.keys()]).toEqual(["b"]);
    expect(clientDoings(db, [], NOW).size).toBe(0);
  });
});
