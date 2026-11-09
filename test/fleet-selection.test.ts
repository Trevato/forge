/**
 * The fleet query grammar (`fleet/selection.ts`), table-driven: every
 * accepted line and what it parses to, every refused line and the message
 * that names its field, then the comparisons, ages and lists against real
 * rows, and hostile values (quotes, `%`, `;`) through every field — bound,
 * never spliced, so they select nothing and break nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { fieldsOf, parseQuery, selectRows, type FleetKind } from "../src/fleet/selection.ts";
import { promote } from "./helpers/members.ts";

describe("parseQuery", () => {
  const accepted: [string, { field: string; op: string; values: string[]; negate?: boolean }][] = [
    ["run cost:>0.5", { field: "cost", op: ">", values: ["0.5"] }],
    ["run cost:<=2", { field: "cost", op: "<=", values: ["2"] }],
    ["run cost:!>=1", { field: "cost", op: ">=", values: ["1"], negate: true }],
    ["issue number:<10", { field: "number", op: "<", values: ["10"] }],
    ["issue number:3,5,8", { field: "number", op: "=", values: ["3", "5", "8"] }],
    ["run created:<7d", { field: "created", op: "<", values: ["7d"] }],
    ["repo created:>30m", { field: "created", op: ">", values: ["30m"] }],
    ["issue updated:12h", { field: "updated", op: "=", values: ["12h"] }],
    ["run state:queued,running", { field: "state", op: "=", values: ["queued", "running"] }],
    ["repo repo:alice/a,bob/b", { field: "repo", op: "=", values: ["alice/a", "bob/b"] }],
    ["issue state:!closed", { field: "state", op: "=", values: ["closed"], negate: true }],
  ];
  for (const [line, want] of accepted)
    test(`reads ${line}`, () => {
      const parsed = parseQuery(line);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const term = parsed.value.terms[0]!;
      expect({ field: term.field, op: term.op as string, values: [...term.values] }).toEqual({
        field: want.field,
        op: want.op,
        values: want.values,
      });
      expect(term.negate).toBe(want.negate ?? false);
    });

  const refused: [string, string][] = [
    ["run cost:abc", "cost wants a number"],
    ["run cost:>abc", "cost wants a number"],
    ["run cost:1,x", "cost wants a number"],
    ["issue number:>1e3", "number wants a number"],
    ["run created:7", "created wants an age"],
    ["run created:<7y", "created wants an age"],
    ["issue updated:>soon", "updated wants an age"],
    ["run state:>queued", "state takes no comparison"],
    ["run cost:>1,2", "cost compares with one value"],
    ["run state:queued,", "state has an empty value"],
    ["issue limb:3,4", "limb takes the number of one issue"],
    ["run color:red", 'run has no field "color"'],
    ["run cost:>", "is not field:value"],
  ];
  for (const [line, message] of refused)
    test(`refuses ${line}: ${message}`, () => {
      const parsed = parseQuery(line);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.message).toContain(message);
    });

  test("one bad term refuses the whole line: no partial selection", () => {
    expect(parseQuery("run state:queued cost:abc").ok).toBe(false);
  });
});

describe("selectRows with comparisons, ages and lists", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  const ids: Record<string, string> = {};
  const select = (line: string): string[] => {
    const parsed = parseQuery(line);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const rows = selectRows(app.db, alice, parsed.value);
    if (!rows.ok) throw new Error(rows.error.message);
    return rows.value;
  };
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const DAY = 86_400_000;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fleet-selection-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    promote(app.db, alice);
    const repo = await createRepo(app, alice, { name: "engine", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const run = (name: string, state: string, cost: number, age: number) => {
      const r = createRun(app.db, { repoId: repo.value.id, kind: "agent" });
      app.db
        .query("UPDATE run SET state = ?1, cost_usd = ?2, created_at = ?3 WHERE id = ?4")
        .run(state, cost, ago(age), r.id);
      ids[name] = r.id;
    };
    run("cheapNew", "queued", 0.1, 60_000);
    run("dearNew", "running", 0.9, 2 * 3_600_000);
    run("dearOld", "ok", 2, 10 * DAY);
    for (const [n, age] of [[1, DAY], [2, 30 * DAY]] as const) {
      const i = createIssue(app.db, { repoId: repo.value.id, authorId: alice.id, title: `i${n}` });
      if (!i.ok) throw new Error(i.error);
      app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(ago(age), i.value.id);
      ids[`issue${n}`] = i.value.id;
    }
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sorted = (names: string[]) => names.map((n) => ids[n]!).sort();
  const cases: [string, string[]][] = [
    ["run cost:>0.5", ["dearNew", "dearOld"]],
    ["run cost:>=2", ["dearOld"]],
    ["run cost:<0.5", ["cheapNew"]],
    ["run cost:<=0.9", ["cheapNew", "dearNew"]],
    ["run cost:!>0.5", ["cheapNew"]],
    ["run cost:0.1,2", ["cheapNew", "dearOld"]],
    ["run created:<1h", ["cheapNew"]],
    ["run created:<7d", ["cheapNew", "dearNew"]],
    ["run created:7d", ["cheapNew", "dearNew"]],
    ["run created:>7d", ["dearOld"]],
    ["run state:queued,running", ["cheapNew", "dearNew"]],
    ["run state:!queued,running", ["dearOld"]],
    ["run state:queued,running cost:>0.5", ["dearNew"]],
    ["issue created:<7d", ["issue1"]],
    ["issue created:>2w", ["issue2"]],
    ["issue number:>1", ["issue2"]],
    ["issue number:1,2", ["issue1", "issue2"]],
  ];
  for (const [line, want] of cases)
    test(line, () => expect([...select(line)].sort()).toEqual(sorted(want)));

  test("quotes, % and ; through every field are bound: nothing selected, nothing broken", () => {
    const hostile = [`'`, `"`, `%`, `;`, `x';DROP TABLE run;--`, `%'%`, `a"b;c`];
    for (const kind of ["repo", "run", "issue"] as FleetKind[])
      for (const field of fieldsOf(kind))
        for (const value of hostile) {
          const parsed = parseQuery(`${kind} ${field}:${value}`);
          // A typed field refuses it at the boundary; a text field binds it.
          if (!parsed.ok) continue;
          const rows = selectRows(app.db, alice, parsed.value);
          if (field === "limb") expect(rows.ok).toBe(false);
          else expect(rows).toEqual({ ok: true, value: [] });
        }
    expect(select("run state:queued,running,ok").length).toBe(3);
  });
});
