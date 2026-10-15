/** Feature flags (#1827): a stable per-viewer percentage, and no dead flags. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLAGS,
  makeFlags,
  parseValue,
  unreadFlags,
} from "../src/core/flags.ts";

const decl = { why: "test", default: false, issue: 1 };
const testFlags = makeFlags({ alpha: decl, beta: { ...decl, default: true } });

function dbWith(rows: Record<string, string>): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE forge_setting (key TEXT PRIMARY KEY, value TEXT)");
  for (const [k, v] of Object.entries(rows))
    db.query("INSERT INTO forge_setting VALUES (?1, ?2)").run(k, v);
  return db;
}

describe("percentage", () => {
  test("30% puts 300±40 of 1000 viewers on, the same answer twice", () => {
    const f = makeFlags({ alpha: decl });
    f.load(dbWith({ "flag.alpha": '{"percent":30}' }));
    const ids = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
    const first = ids.map((id) => f.flag("alpha", { id }));
    const on = first.filter(Boolean).length;
    expect(Math.abs(on - 300)).toBeLessThanOrEqual(40);
    expect(ids.map((id) => f.flag("alpha", { id }))).toEqual(first);
  });

  test("0 is nobody, 100 is everybody, a signed-out viewer is never in", () => {
    const f = makeFlags({ alpha: decl });
    f.load(dbWith({ "flag.alpha": '{"percent":100}' }));
    expect(f.flag("alpha", { id: "x" })).toBe(true);
    expect(f.flag("alpha")).toBe(false);
    f.load(dbWith({ "flag.alpha": '{"percent":0}' }));
    expect(f.flag("alpha", { id: "x" })).toBe(false);
  });
});

describe("values", () => {
  test("unset and unreadable are the default; boot never fails", () => {
    expect(testFlags.flag("alpha")).toBe(false);
    expect(testFlags.flag("beta")).toBe(true);
    testFlags.load(new Database(":memory:")); // no table at all
    expect(testFlags.flag("beta", { id: "u" })).toBe(true);
    testFlags.load(dbWith({ "flag.alpha": "{not json", "flag.beta": "[]" }));
    expect(testFlags.flag("alpha")).toBe(false);
    expect(testFlags.flag("beta")).toBe(true);
  });

  test("forge, user and role values", () => {
    const f = makeFlags({ alpha: decl, beta: decl, gamma: decl });
    f.load(
      dbWith({
        "flag.alpha": '{"forge":true}',
        "flag.beta": '{"users":["u1"]}',
        "flag.gamma": '{"roles":["admin"]}',
      }),
    );
    expect(f.flag("alpha")).toBe(true);
    expect(f.flag("beta", { id: "u1" })).toBe(true);
    expect(f.flag("beta", { id: "u2" })).toBe(false);
    expect(f.flag("gamma", { id: "u2", role: "admin" })).toBe(true);
    expect(f.flag("gamma", { id: "u2", role: "member" })).toBe(false);
  });

  test("a value out of range or of the wrong shape is ignored", () => {
    expect(parseValue('{"percent":101}')).toEqual({});
    expect(parseValue('{"users":[1]}')).toEqual({});
    expect(parseValue("null")).toBeUndefined();
  });

  test("a name that is not a declared flag is a type error", () => {
    // @ts-expect-error — "nope" is not declared
    expect(() => testFlags.flag("nope")).toThrow();
  });
});

describe("declared flags", () => {
  test("every one is read by some file in src/", () => {
    const sources = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".ts"))
          sources.set(rel, readFileSync(join(root, rel), "utf8"));
      }
    };
    walk("src");
    expect(unreadFlags(Object.keys(FLAGS), sources)).toEqual([]);
  });

  test("a declared flag no file reads is named", () => {
    const sources = new Map([
      ["src/a.ts", 'if (flag("used", v)) {}'],
      ["src/core/flags.ts", 'flag("lonely"'],
    ]);
    expect(unreadFlags(["used", "lonely"], sources)).toEqual(["lonely"]);
  });
});

const root = new URL("..", import.meta.url).pathname;
