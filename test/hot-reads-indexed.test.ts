/** The two reads that held the main thread answer from an index, not a scan or a sort (#8061). Judged by the query plan of the SQL they actually run, never the clock. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { closedByReview, reviewedClosed } from "../src/core/gate_hold.ts";
import { askToLiveByPillar } from "../src/core/pillars.ts";

let root = "";
let app: App;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-hot-reads-"));
  app = createApp({ dataDir: root, port: 0 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The plan lines of every statement `work` runs, with its parameters bound as NULLs. */
function plans(work: () => void): string[] {
  const db = app.db;
  const original = db.query.bind(db);
  const sqls: string[] = [];
  (db as unknown as { query: unknown }).query = (sql: string) => {
    sqls.push(sql);
    return original(sql);
  };
  try {
    work();
  } finally {
    (db as unknown as { query: unknown }).query = original;
  }
  return sqls
    .filter((sql) => /^\s*SELECT/i.test(sql))
    .flatMap((sql) => {
      const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const args = Array.from({ length: n }, () => "x");
      return original(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...args)
        .map((row) => (row as { detail: string }).detail);
    });
}

const noScan = (lines: string[]) => {
  for (const line of lines) {
    expect(line).not.toMatch(/^SCAN (?!.*USING (COVERING )?INDEX)/);
    expect(line).not.toContain("TEMP B-TREE");
  }
};

test("an event of one kind, newest first, is read in index order", () => {
  const byRepo = plans(() => void listEvents(app.db, { repoId: "r", kind: "pull.closed", limit: 5 }));
  expect(byRepo.join("\n")).toContain("event_repo_kind_seq");
  noScan(byRepo);
  const byKind = plans(() => void listEvents(app.db, { kind: "clog.cleared", limit: 1 }));
  expect(byKind.join("\n")).toContain("event_kind_seq");
  noScan(byKind);
});

test("the window of merged pulls walks the merged ones, not the repository's issues", () => {
  const set = { pillars: [] } as never;
  const lines = plans(() => void askToLiveByPillar(app.db, "r", set, new Map(), "2026-01-01T00:00:00Z"));
  expect(lines.join("\n")).toContain("pull_merged");
  expect(lines.join("\n")).not.toContain("issue_repo_updated");
});

test("whether the Later gate review closed an issue reads the event index, not the table", () => {
  const one = plans(() => void closedByReview(app.db, { id: "i", state: "closed" } as never));
  expect(one.join("\n")).toContain("SEARCH e USING");
  noScan(one.filter((l) => !/^SCAN issue|SEARCH issue/.test(l)));
  const many = plans(
    () => void reviewedClosed(app.db, { id: "r" } as never, { gate: { id: "g" } } as never),
  );
  expect(many.join("\n")).toContain("SEARCH e USING");
  noScan(many);
});
