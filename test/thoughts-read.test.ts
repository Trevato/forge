import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import migration from "../src/core/migrations/0081-thoughts.ts";
import { recentThoughts, thoughtOf } from "../src/core/thoughts.ts";

let db: Database;

function keep(id: string, author: string, text: string, receivedAt: string): void {
  db.query("INSERT INTO thought (id, author, text, source, received_at) VALUES (?1, ?2, ?3, 'api', ?4)").run(
    id,
    author,
    text,
    receivedAt,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(migration);
});

describe("reading thoughts back", () => {
  test("newest first, cut at limit, and only at or after since", () => {
    keep("t1", "ann", "one", "2026-01-01T00:00:01.000Z");
    keep("t2", "ann", "two", "2026-01-01T00:00:02.000Z");
    keep("t3", "ann", "three", "2026-01-01T00:00:03.000Z");
    keep("t4", "ann", "four", "2026-01-01T00:00:04.000Z");
    expect(recentThoughts(db, "ann", 10).map((t) => t.id)).toEqual(["t4", "t3", "t2", "t1"]);
    expect(recentThoughts(db, "ann", 2).map((t) => t.id)).toEqual(["t4", "t3"]);
    expect(recentThoughts(db, "ann", 10, "2026-01-01T00:00:03.000Z").map((t) => t.id)).toEqual(["t4", "t3"]);
    expect(recentThoughts(db, "ann", 10, "2027-01-01T00:00:00.000Z")).toEqual([]);
  });

  test("another person gets none of them, and thoughtOf with the wrong author is undefined", () => {
    keep("t1", "ann", "mine", "2026-01-01T00:00:01.000Z");
    keep("t2", "bob", "his", "2026-01-01T00:00:02.000Z");
    expect(recentThoughts(db, "bob", 10).map((t) => t.id)).toEqual(["t2"]);
    expect(recentThoughts(db, "cy", 10)).toEqual([]);
    expect(thoughtOf(db, "bob", "t1")).toBeUndefined();
    expect(thoughtOf(db, "ann", "t1")?.text).toBe("mine");
    expect(thoughtOf(db, "ann", "nope")).toBeUndefined();
  });

  test("text with markup, emoji and newlines comes back byte for byte", () => {
    const text = "  <script>alert(\"x\")</script> & 🚀 é\r\nline two\n\n\ttabbed  ";
    keep("t1", "ann", text, "2026-01-01T00:00:01.000Z");
    expect(recentThoughts(db, "ann", 1)[0]!.text).toBe(text);
    expect(thoughtOf(db, "ann", "t1")!.text).toBe(text);
  });
});
