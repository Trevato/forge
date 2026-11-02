/**
 * docs/CACHING.md is a design that later code is held to (#2715): every
 * write its tables name must exist and still append the event the doc says
 * moves the cache's head, and the bench that produced its numbers must
 * still run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchMapHome,
  seedFixture,
  type Fixture,
  type Shape,
} from "../bench/map-home.ts";
import { quietLogs } from "./helpers/globals.ts";

// `seedFixture` raises the log floor and never lowers it: borrowed for
// this file, and given back to whichever file runs next (#7419).
quietLogs();

const root = join(import.meta.dir, "..");
const doc = readFileSync(join(root, "docs/CACHING.md"), "utf8");

interface Row {
  readonly table: string;
  readonly path: string;
  readonly fn: string;
  readonly kind: string;
}

/** Every `| `dir/file#fn` | `event` | … |` row under a "… writes" heading. */
function writeRows(markdown: string): Row[] {
  const rows: Row[] = [];
  let table = "";
  for (const line of markdown.split("\n")) {
    const heading = /^###\s+(.+ writes)\b/.exec(line);
    if (heading) table = heading[1]!;
    else if (line.startsWith("#")) table = "";
    if (table === "") continue;
    const row = /^\|\s*`([a-z_/-]+)#([A-Za-z]+)`\s*\|\s*`([a-z_.]+)`\s*\|/.exec(
      line,
    );
    if (row) rows.push({ table, path: row[1]!, fn: row[2]!, kind: row[3]! });
  }
  return rows;
}

/**
 * Whether a source file appends `kind`: as a literal, or as the template
 * the issue actions use (`${issue.kind}.edited`, `"closed" : "reopened"`).
 */
function names(source: string, kind: string): boolean {
  if (source.includes(`"${kind}"`) || source.includes(`\`${kind}\``))
    return true;
  const dot = kind.indexOf(".");
  const [prefix, suffix] = [kind.slice(0, dot), kind.slice(dot + 1)];
  const suffixed =
    source.includes(`.${suffix}\``) || source.includes(`"${suffix}"`);
  const prefixed =
    source.includes(`"${prefix}.`) ||
    ((prefix === "issue" || prefix === "pull") &&
      source.includes("${issue.kind}."));
  return suffixed && prefixed;
}

describe("docs/CACHING.md", () => {
  const rows = writeRows(doc);

  test("has the three write tables, each with rows", () => {
    const tables = new Set(rows.map((r) => r.table));
    expect([...tables].sort()).toEqual([
      "KPI writes",
      "Lane writes",
      "Panel writes",
    ]);
    expect(rows.filter((r) => r.table === "Lane writes").length).toBeGreaterThan(
      20,
    );
  });

  test("every write it names exists, and appends the event beside it", () => {
    const wrong: string[] = [];
    for (const row of rows) {
      const file = join(root, "src", `${row.path}.ts`);
      if (!existsSync(file)) {
        wrong.push(`${row.path}: no such file`);
        continue;
      }
      const source = readFileSync(file, "utf8");
      // An action is called from elsewhere, so it is exported; the hook is
      // the one writer outside src/actions/, and private to its server.
      const declared = row.path.startsWith("actions/")
        ? new RegExp(`export (async )?function ${row.fn}\\b`)
        : new RegExp(`function ${row.fn}\\b`);
      if (!declared.test(source))
        wrong.push(`${row.path}#${row.fn}: not declared there`);
      if (!names(source, row.kind))
        wrong.push(`${row.path}#${row.fn}: never appends ${row.kind}`);
    }
    expect(wrong).toEqual([]);
  });

  test("the matcher is not a yes-machine", () => {
    expect(names('kind: "issue.blocked"', "issue.blocked")).toBe(true);
    expect(names("kind: `${issue.kind}.edited`", "issue.edited")).toBe(true);
    expect(names('kind: "issue.blocked"', "issue.edited")).toBe(false);
    expect(names("kind: `${issue.kind}.edited`", "repo.edited")).toBe(false);
  });

  test("each cache says what, key, invalidated by and max age", () => {
    const caches = doc.split(/^### \d\. /m).slice(1);
    expect(caches.length).toBe(6);
    for (const cache of caches)
      for (const part of ["**What:**", "**Key:**", "**Invalidated by:**", "**Max age:**"])
        expect(cache).toContain(part);
  });

  test("it carries the bench's numbers for both pages and both viewers", () => {
    for (const row of [
      "`GET /map` owner",
      "`GET /map` stranger",
      "`GET /` owner",
      "`GET /` stranger",
    ])
      expect(doc).toMatch(
        new RegExp(`\\| ${row.replace(/[/|]/g, "\\$&")}\\s*\\|\\s*[\\d.]+ \\|\\s*[\\d.]+ \\|\\s*[\\d.]+ \\|`),
      );
    expect(doc).toContain("bun run bench/map-home.ts");
  });
});

// A shape small enough for the gate: the same code path the forge-sized
// numbers came from, so the bench cannot rot unnoticed.
const SMALL: Shape = {
  repos: 6,
  bigIssues: 40,
  bigOpen: 12,
  bigGraph: 20,
  bigEdges: 24,
  bigPulls: 2,
  lanes: [5, 3, 2],
  privateLanes: 1,
  sealed: 1,
  runs: 2,
  comments: 1,
  events: 50,
};

describe("bench/map-home.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-caching-doc-"));
  let fixture: Fixture | undefined;
  afterAll(() => {
    fixture?.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("measures the six cases, counting statements", async () => {
    fixture = await seedFixture(dir, SMALL);
    const samples = await benchMapHome(fixture, 2);
    expect(samples.map((s) => [s.name, s.status])).toEqual([
      ["GET /map  owner", 200],
      ["GET /map  stranger", 200],
      ["GET /map  anonymous", 303],
      ["GET /     owner", 200],
      ["GET /     stranger", 200],
      ["GET /     anonymous", 200],
    ]);
    for (const s of samples.filter((s) => s.status === 200))
      expect(s.sql).toBeGreaterThan(0);
  }, 60_000);

  test("the stranger's map holds no private lane, before or after the owner's", async () => {
    const f = fixture!;
    const { serve } = await import("../src/http/server.ts");
    const servers = await serve(f.app);
    try {
      const map = async (cookie: string): Promise<string> =>
        (await fetch(`${servers.url}/map`, { headers: { cookie } })).text();
      const before = await map(f.strangerCookie);
      const owners = await map(f.ownerCookie);
      const after = await map(f.strangerCookie);
      expect(f.privateRepos.length).toBe(1);
      for (const full of f.privateRepos) {
        const [, name] = full.split("/") as [string, string];
        expect(owners).toContain(`lane-${full.replace("/", "-")}`);
        expect(before).not.toContain(name);
        expect(after).not.toContain(name);
      }
    } finally {
      servers.stop();
    }
  }, 60_000);
});
