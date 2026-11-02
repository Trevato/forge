/** The flow panel's idle-pull and parked lines (#6480): drawn when non-zero, each linking what it names. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

const ago = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
let app: App;
let alice: string;
let scout: string;

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "panel-idle-")), port: 0 });
  const mk = async (username: string, first: boolean): Promise<string> => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value.id;
  };
  alice = await mk("alice", true);
  scout = await mk("scout", false);
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [scout]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy_by) VALUES ('pub', ?1, 'pub', 'public', ?1)", [alice]);
});
afterAll(() => app.close?.());

const draw = (kind: "owner" | "agent"): string => String(flowPanel(app, { kind }, new URL("http://x/boards"), "/boards"));

describe("flow panel idle pulls and parked", () => {
  test("neither line is drawn with nothing idle or parked", () => {
    const page = draw("owner");
    expect(page).not.toContain('id="idle-pulls"');
    expect(page).not.toContain('id="parked"');
  });

  test("one idle pull and one parked issue are drawn and linked", () => {
    app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES ('p1', 'pub', 1, 'pull', 't', '', ?1, 'open', ?2)", [scout, ago(100)]);
    app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES ('p1', 'main', 'b', '', 'h')");
    app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES ('i2', 'pub', 2, 'issue', 'Stuck', '', ?1, 'open')", [alice]);
    app.db.run("INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES ('c1', 'i2', ?1, 'Parked by the crew: could not finish.', ?2)", [alice, ago(1)]);
    for (const kind of ["owner", "agent"] as const) {
      const page = draw(kind);
      expect(page).toContain('id="idle-pulls"');
      expect(page).toContain("1 idle pull:");
      expect(page).toContain('href="/alice/pub/pulls/1"');
      expect(page).toContain("1 parked today, 1 this week");
      expect(page).toContain('href="/alice/pub/issues/2"');
    }
  });
});

describe("flow panel public cut", () => {
  test("a private repo's idle pull and parked issue, and a sealed parked issue, show to the owner only", () => {
    app.db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy_by) VALUES ('priv', ?1, 'priv', 'private', ?1)", [alice]);
    app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES ('pp', 'priv', 1, 'pull', 't', '', ?1, 'open', ?2)", [scout, ago(200)]);
    app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES ('pp', 'main', 'b', '', 'h')");
    const parkedIssue = (id: string, repo: string, n: number, sealed: number): void => {
      app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, sealed) VALUES (?1, ?2, ?3, 'issue', 'S', '', ?4, 'open', ?5)", [id, repo, n, alice, sealed]);
      app.db.run("INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, 'Parked by the crew: x.', ?4)", ["c" + id, id, alice, ago(0.5)]);
    };
    parkedIssue("pi", "priv", 5, 0);
    parkedIssue("si", "pub", 9, 1);
    const owner = draw("owner");
    expect(owner).toContain("2 idle pulls");
    expect(owner).toContain("/alice/priv/pulls/1");
    expect(owner).toContain("3 parked today, 3 this week");
    const agent = draw("agent");
    expect(agent).toContain("1 idle pull:");
    expect(agent).not.toContain("/alice/priv/");
    expect(agent).not.toContain("/alice/pub/issues/9");
    expect(agent).toContain("1 parked today, 1 this week");
  });
});

describe("flow panel many idle pulls", () => {
  test("lists three as rows and links the rest to the pulls list; links carry no aria-label", () => {
    for (let n = 20; n < 23; n++) {
      app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, 'pub', ?2, 'pull', 't', '', ?3, 'open', ?4)", [`m${n}`, n, scout, ago(300)]);
      app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, '', 'h')", [`m${n}`, `m${n}`]);
    }
    const page = draw("agent");
    const idle = page.slice(page.indexOf('id="idle-pulls"'), page.indexOf('id="parked"'));
    expect(idle).toContain("4 idle pulls");
    expect(idle.match(/<li/g)?.length).toBe(4);
    expect(idle).toMatch(/<a class="row flow-row small" href="\/boards\?idle=all#idle-list"[^>]*>/);
    expect(idle).toContain("and 1 more");
    const all = String(flowPanel(app, { kind: "agent" }, new URL("http://x/boards?idle=all"), "/boards"));
    const list = all.slice(all.indexOf('id="idle-list"'));
    expect(list).toContain("4 idle pulls");
    expect(list.match(/flow-row/g)?.length).toBe(4);
    expect(page).not.toContain('id="idle-list"');
    expect(idle).not.toContain("aria-label");
  });
});

describe("flow panel idle pulls at the cap", () => {
  test("says 20+ when the read stopped at its limit", () => {
    for (let n = 100; n < 120; n++) {
      app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, 'pub', ?2, 'pull', 't', '', ?3, 'open', ?4)", [`c${n}`, n, scout, ago(300)]);
      app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, '', 'h')", [`c${n}`, `c${n}`]);
    }
    const page = draw("agent");
    expect(page).toContain("20+ idle pulls:");
    expect(page).toContain("and 17+ more");
    const all = String(flowPanel(app, { kind: "agent" }, new URL("http://x/boards?idle=all"), "/boards"));
    expect(all).toContain("<h2>20+ idle pulls</h2>");
  });
});
