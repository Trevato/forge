/** The data tree: grouping, filter, parent, paging, one read per open node, an unreadable file. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync, rmSync } from "node:fs";
import type { Source } from "../src/data/sources.ts";
import { filtered, newReads, opens, parentKey, visible } from "../src/data/tree.ts";

let dir: string;
let good: Source;
let bad: Source;
let forgeDb: Source;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tree-"));
  const p = join(dir, "app.db");
  const d = new Database(p);
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)");
  d.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 60) INSERT INTO t SELECT i, 'n' || i FROM c");
  d.exec("CREATE TABLE ctl (v TEXT)");
  d.run("INSERT INTO ctl VALUES (?)", ["a\u001b[31mb\u0007\nc"]);
  d.close();
  const where = { repo: "alice/notes", app: "notes", env: "production", file: "app.db" };
  good = { id: "g", label: "notes · production · app.db", kind: "app", path: p, where };
  bad = { id: "b", label: "notes · production · bad.db", kind: "app", path: join(dir, "bad.db"), where: { ...where, file: "bad.db" } };
  await Bun.write(bad.path, "this is not a database, only text".repeat(40));
  forgeDb = { id: "forge", label: "forge", kind: "forge", path: p };
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const all = (open: string[]) => visible([good, bad, forgeDb], new Set(open));

test("files outside any app come first, then repos group apps, envs and files", () => {
  const nodes = visible([good, bad, forgeDb], new Set());
  expect(nodes.map((n) => [n.kind, n.label])).toEqual([["file", "forge.db"], ["repo", "alice/notes"]]);
  const repo = nodes[1]!;
  const deeper = visible([good, bad, forgeDb], new Set([repo.key]));
  expect(deeper.map((n) => n.kind)).toEqual(["file", "repo", "app"]);
  expect(opens(deeper[2]!)).toBe(true);
});

test("parentKey names the line above, undefined at the top", () => {
  const nodes = all([]);
  const repo = nodes.find((n) => n.kind === "repo")!;
  const app = visible([good], new Set([repo.key])).find((n) => n.kind === "app")!;
  expect(parentKey(app.key)).toBe(repo.key);
  expect(parentKey(repo.key)).toBeUndefined();
});

test("filtered keeps hits and the lines that lead to them; empty keeps all", () => {
  const repo = all([]).find((n) => n.kind === "repo")!;
  const open = new Set<string>([repo.key]);
  let nodes = visible([good], open);
  const app = nodes.find((n) => n.kind === "app")!;
  open.add(app.key);
  nodes = visible([good], open);
  expect(filtered(nodes, "").length).toBe(nodes.length);
  expect(filtered(nodes, "  ").length).toBe(nodes.length);
  expect(filtered(nodes, "PRODUCTION").map((n) => n.kind)).toEqual(["repo", "app", "env"]);
  expect(filtered(nodes, "zzz")).toEqual([]);
});

function openAll(sources: Source[], extra: (k: string) => boolean = () => false) {
  const open = new Set<string>();
  const reads = newReads();
  const pages = new Map<string, number>();
  for (let i = 0; i < 6; i++)
    for (const n of visible(sources, open, reads, pages)) if (n.kind !== "row" && (n.kind !== "table" || extra(n.label))) open.add(n.key);
  return { open, reads, pages };
}

test("an unreadable file shows as a file with no tables, and the rest still shows", () => {
  const { open } = openAll([good, bad]);
  const nodes = visible([good, bad], open);
  const labels = nodes.map((n) => n.label);
  expect(labels).toContain("bad.db");
  expect(labels).toContain("app.db");
  const at = nodes.findIndex((n) => n.label === "bad.db");
  expect(nodes[at + 1]?.kind).not.toBe("table");
});

test("a table pages 50 rows at a time, and a row carries its JSON", () => {
  const { open, reads, pages } = openAll([good], (l) => l.startsWith("t "));
  const rows = (page: number) => {
    const t = visible([good], open, reads, pages).find((n) => n.kind === "table" && n.table === "t")!;
    pages.set(t.key, page);
    return visible([good], open, reads, pages).filter((n) => n.kind === "row" && n.table === "t");
  };
  expect(rows(0).length).toBe(50);
  expect(rows(1).length).toBe(10);
  expect(rows(1)[0]!.json).toEqual({ id: 51, note: "n51" });
});

test("a rebuild reads nothing again while the reads are kept", () => {
  const copy = join(dir, "gone.db");
  copyFileSync(good.path, copy);
  const src: Source = { ...good, id: "x", path: copy };
  const { open, reads, pages } = openAll([src], (l) => l.startsWith("t "));
  const first = visible([src], open, reads, pages).map((n) => n.label);
  rmSync(copy);
  expect(visible([src], open, reads, pages).map((n) => n.label)).toEqual(first);
  expect(visible([src], open, newReads(), pages).filter((n) => n.kind === "table")).toEqual([]);
});

test("a table carries its row count as data, not only in its label", () => {
  const { open } = openAll([good], () => false);
  const t = visible([good], open).find((n) => n.kind === "table" && n.table === "t")!;
  expect(typeof t.total).toBe("number");
  expect(t.label).toContain(`${t.total} rows`);
});

test("a control byte or newline in a cell never reaches a row's line", () => {
  const { open } = openAll([good], (l) => l.startsWith("ctl"));
  const row = visible([good], open).find((n) => n.kind === "row" && n.table === "ctl")!;
  expect(row.label).toBe("a [31mb c");
  expect(row.label).not.toMatch(/[\u0000-\u001f\u007f]/);
});
