/**
 * The asks ledger's measure (#6625): raised, acted, dismissed and expired
 * since a time, per viewer; and a repository's recent ends, newest first.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import ledgerSql from "../src/core/migrations/0049-the-asks-ledger.ts";
import { askMeasure, recentEnds } from "../src/core/ask_ledger.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(ledgerSql);
});

let n = 0;
function row(
  viewer: string,
  raisedAt: string,
  end?: [string, "acted" | "dismissed" | "expired"],
  repo = "r1",
  kind = "review",
): void {
  db.run(
    "INSERT INTO ask_ledger (id, viewer_id, ask_id, repo_id, kind, raised_at, ended_at, ended_how) VALUES (?,?,?,?,?,?,?,?)",
    [`row${++n}`, viewer, `ask${n}`, repo, kind, raisedAt, end?.[0] ?? null, end?.[1] ?? null],
  );
}

describe("askMeasure", () => {
  test("counts only the asking viewer's rows", () => {
    row("a", "2026-10-10T00:00:00Z", ["2026-10-11T00:00:00Z", "acted"]);
    row("b", "2026-10-10T00:00:00Z", ["2026-10-11T00:00:00Z", "dismissed"]);
    row("b", "2026-10-10T00:00:00Z");
    expect(askMeasure(db, "a", "2026-10-01T00:00:00Z")).toEqual({
      raised: 1,
      acted: 1,
      dismissed: 0,
      expired: 0,
    });
    expect(askMeasure(db, "b", "2026-10-01T00:00:00Z")).toEqual({
      raised: 2,
      acted: 0,
      dismissed: 1,
      expired: 0,
    });
    expect(askMeasure(db, "nobody", "2026-10-01T00:00:00Z")).toEqual({
      raised: 0,
      acted: 0,
      dismissed: 0,
      expired: 0,
    });
  });

  test("raised counts asks raised at or after since", () => {
    row("a", "2026-10-09T23:59:59Z");
    row("a", "2026-10-10T00:00:00Z");
    row("a", "2026-10-11T00:00:00Z");
    expect(askMeasure(db, "a", "2026-10-10T00:00:00Z").raised).toBe(2);
  });

  test("ends count by when they ended, even if raised before since", () => {
    const old = "2026-09-01T00:00:00Z";
    row("a", old, ["2026-10-10T00:00:00Z", "acted"]);
    row("a", old, ["2026-10-12T00:00:00Z", "dismissed"]);
    row("a", old, ["2026-10-13T00:00:00Z", "expired"]);
    row("a", old, ["2026-10-09T23:59:59Z", "expired"]);
    expect(askMeasure(db, "a", "2026-10-10T00:00:00Z")).toEqual({
      raised: 0,
      acted: 1,
      dismissed: 1,
      expired: 1,
    });
  });

  test("an open ask counts as raised and nothing else", () => {
    row("a", "2026-10-10T00:00:00Z");
    expect(askMeasure(db, "a", "2026-10-01T00:00:00Z")).toEqual({
      raised: 1,
      acted: 0,
      dismissed: 0,
      expired: 0,
    });
  });
});

describe("recentEnds", () => {
  test("lists one repository's ends newest first, for that viewer", () => {
    row("a", "2026-10-01T00:00:00Z", ["2026-10-02T00:00:00Z", "acted"], "r1", "k1");
    row("a", "2026-10-01T00:00:00Z", ["2026-10-04T00:00:00Z", "expired"], "r1", "k2");
    row("a", "2026-10-01T00:00:00Z", ["2026-10-03T00:00:00Z", "dismissed"], "r1", "k3");
    row("a", "2026-10-01T00:00:00Z", ["2026-10-05T00:00:00Z", "acted"], "r2", "other");
    row("b", "2026-10-01T00:00:00Z", ["2026-10-06T00:00:00Z", "acted"], "r1", "theirs");
    row("a", "2026-10-01T00:00:00Z", undefined, "r1", "open");
    expect(recentEnds(db, "a", "r1")).toEqual([
      { kind: "k2", how: "expired", at: "2026-10-04T00:00:00Z" },
      { kind: "k3", how: "dismissed", at: "2026-10-03T00:00:00Z" },
      { kind: "k1", how: "acted", at: "2026-10-02T00:00:00Z" },
    ]);
    expect(recentEnds(db, "a", "r1", 2).map((e) => e.kind)).toEqual(["k2", "k3"]);
  });
});
