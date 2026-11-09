/** The held-ready table speaks the home page's language: a section under an h2, no card (#9955). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers;
let owner = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-held-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  for (const [username, extra] of [["alice", { adminIfFirst: true }], ["bobby", {}]] as const) {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "correct-horse-battery", ...extra });
    if (!u.ok) throw new Error(u.error);
  }
  const alice = getUserByName(app.db, "alice")!.id;
  const repo = (id: string, name: string, vis: string): void => {
    app.db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy, autonomy_by) VALUES (?1, ?4, ?2, ?3, 'autonomous', ?4)", [id, name, vis, alice]);
  };
  repo("pub", "open-one", "public");
  repo("priv", "secret-plans", "private");
  for (const [id, r, n] of [["p1", "pub", 1], ["p2", "pub", 2], ["q1", "priv", 1]] as const) {
    app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'issue', 't', '', ?4, 'open')", [id, r, n, alice]);
  }
  app.db.run("INSERT INTO run (id, repo_id, kind, issue_id, state) VALUES ('run-p2', 'pub', 'agent', 'p2', 'running')");
  owner = `forge_session=${createSession(app.db, alice).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const held = async (path: string, cookie: string): Promise<string> => {
  const page = await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
  const m = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
  const i = m.indexOf('id="held"');
  return i < 0 ? "" : m.slice(m.lastIndexOf("<", i), m.indexOf("</section>", i) + 10);
};

test("/boards: held-ready is a section with an h2, no card, one row per repository", async () => {
  const h = await held("/boards", owner);
  expect(h).toMatch(/^<section class="settings-block" id="held">\s*<h2>Ready, and why it waits<\/h2>/);
  expect(h).not.toContain('class="card');
  expect((h.match(/data-held-repo=/g) ?? []).length).toBe(2);
  expect(h).toContain('data-held-repo="alice/open-one"');
  expect(h).toContain("startable=1");
  expect(h).toContain("running=1");
});

test("/flow draws no held table, so there is no card#held there either", async () => {
  const page = await (await fetch(`${servers.url}/flow`, { headers: { cookie: owner } })).text();
  expect(page).toContain("<main");
  expect(page).not.toContain('id="held"');
  expect(page).not.toContain("data-held-repo=");
});

test("a reader who cannot read the private repository gets the public row only", () => {
  const h = String(flowPanel(app, { kind: "agent" }, new URL("http://x/boards"), "/boards"));
  expect(h).toContain('data-held-repo="alice/open-one"');
  expect(h).not.toContain("secret-plans");
});
