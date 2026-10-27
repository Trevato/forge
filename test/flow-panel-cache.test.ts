/** The flow panel's figures are kept (#6974): a second load inside the window runs no reader, a write or 30 s ends it, and an agent never gets the admin's. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { PANEL_TTL_MS, panelFigures } from "../src/flow/panel_cache.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

let app: App;
let alice: string;

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "panel-cache-")), port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value.id;
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('pub', ?1, 'pub', 'public')", [alice]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('priv', ?1, 'priv', 'private')", [alice]);
}, 30_000);
afterAll(() => app.close?.());

/** Statements run against the db, counted. */
function counting(): { n: () => number; stop: () => void } {
  let n = 0;
  const q = app.db.query.bind(app.db);
  const orig = app.db.query;
  (app.db as unknown as { query: unknown }).query = (sql: string) => {
    if (!/total_changes|data_version/.test(sql)) n++;
    return q(sql as never);
  };
  return { n: () => n, stop: () => ((app.db as unknown as { query: unknown }).query = orig) };
}

describe("flow panel cache", () => {
  test("a second load inside the window runs none of the readers", () => {
    const t = new Date();
    panelFigures(app.db, "owner", t);
    const c = counting();
    const again = panelFigures(app.db, "owner", new Date(t.getTime() + 1000));
    const ran = c.n();
    c.stop();
    expect(ran).toBe(0);
    expect(again).toBe(panelFigures(app.db, "owner", t));
  });

  test("a write makes the next load read again", () => {
    const t = new Date();
    const first = panelFigures(app.db, "owner", t);
    app.db.run("UPDATE repo SET description = 'x' WHERE id = 'pub'");
    expect(panelFigures(app.db, "owner", t)).not.toBe(first);
  });

  test("it reads again after 30 s with nothing written", () => {
    const t = new Date(Date.now() + 10 * PANEL_TTL_MS);
    const first = panelFigures(app.db, "owner", t);
    expect(panelFigures(app.db, "owner", new Date(t.getTime() + PANEL_TTL_MS - 1))).toBe(first);
    expect(panelFigures(app.db, "owner", new Date(t.getTime() + PANEL_TTL_MS))).not.toBe(first);
  });

  test("an agent never sees an admin's figures", () => {
    // no password hashing here: a loaded machine took it past the test's timeout
    const agentId = "agent-scout";
    app.db.run("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES (?1, 'scout', 'scout@forge.local', 'x', 1)", [agentId]);
    const ago = new Date(Date.now() - 1_800_000).toISOString();
    for (const [id, n, repo] of [["a1", 1, "pub"], ["a2", 2, "priv"]] as const) {
      app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?5, 'open', ?4)", [id, repo, n, ago, agentId]);
      app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'b', '', 'h')", [id]);
    }
    const t = new Date();
    const owner = panelFigures(app.db, "owner", t);
    const agent = panelFigures(app.db, "agent", t);
    expect(agent).not.toBe(owner);
    expect(owner.openers.reduce((n, o) => n + o.opened, 0)).toBe(2);
    expect(agent.openers.reduce((n, o) => n + o.opened, 0)).toBe(1);
    // asked the other way round, still apart (by value: a background write on another connection may end the kept copy)
    expect(panelFigures(app.db, "owner", t)).toEqual(owner);
    expect(panelFigures(app.db, "agent", t)).toEqual(agent);
  });

  test("the panel draws from it", () => {
    const page = String(flowPanel(app, { kind: "owner" }, new URL("http://x/boards"), "/boards"));
    expect(page).toContain('id="openers"');
  });
});
