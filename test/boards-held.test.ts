/** The held card (#6857): a private repository's row of why issues wait is drawn for its owner only, with the counts `flow/held.ts` holds. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { readHeld } from "../src/flow/held.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";
import { heldCard } from "../src/web/pages/boards-held.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const MARKUP = "<img src=x onerror=alert(1)>";
const SECRET = "secret-plans";
let app: App;
let alice = "";

function issue(id: string, repo: string, n: number): void {
  app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'issue', 't', '', ?4, 'open')", [id, repo, n, alice]);
}
function running(repo: string, issueId: string): void {
  app.db.run("INSERT INTO run (id, repo_id, kind, issue_id, state) VALUES (?1, ?2, 'agent', ?3, 'running')", [`run-${issueId}`, repo, issueId]);
}

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "boards-held-")), port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value.id;
  const repo = (id: string, name: string, visibility: string): void => {
    app.db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy, autonomy_by) VALUES (?1, ?4, ?2, ?3, 'autonomous', ?4)", [id, name, visibility, alice]);
  };
  repo("pub", MARKUP, "public");
  repo("priv", SECRET, "private");
  // pub: two startable, one with a run on it. priv: one startable, two with a run.
  issue("p1", "pub", 1);
  issue("p2", "pub", 2);
  issue("p3", "pub", 3);
  running("pub", "p3");
  issue("q1", "priv", 1);
  issue("q2", "priv", 2);
  issue("q3", "priv", 3);
  running("priv", "q2");
  running("priv", "q3");
});
afterAll(() => app.close?.());

const row = (page: string, repo: string): string => page.split("<tr data-held-repo=").find((r) => r.startsWith(`"${repo}"`)) ?? "";

describe("held card", () => {
  test("the counts are the ones flow/held.ts holds for the seeded holds", () => {
    const rows = readHeld(app, true, NOW);
    const pub = rows.find((r) => r.repo === `alice/${MARKUP}`)!;
    const priv = rows.find((r) => r.repo === `alice/${SECRET}`)!;
    expect([pub.startable, pub.counts.running]).toEqual([2, 1]);
    expect([priv.startable, priv.counts.running]).toEqual([1, 2]);
    const page = String(heldCard(rows));
    const privRow = row(page, `alice/${SECRET}`);
    expect(privRow).toContain('data-held="startable"><span class="num">1</span> startable<');
    expect(privRow).toContain('data-held="running"><span class="num">2</span> running<');
    expect(privRow).toContain("1 of 3 ready can start");
    expect(privRow).not.toContain('data-held="stalled"');
  });

  test("the owner's panel has both rows", () => {
    const page = String(flowPanel(app, { kind: "owner" }, new URL("http://x/boards"), "/boards"));
    expect(page).toContain(`data-held-repo="alice/${SECRET}"`);
    expect(page).toContain('data-held-repo="alice/&lt;img');
  });

  test("a reader who cannot read the private repository gets the public row only, and never its name", () => {
    const cut = readHeld(app, false, NOW);
    expect(cut.map((r) => r.public)).toEqual([true]);
    for (const page of [String(heldCard(cut)), String(flowPanel(app, { kind: "agent" }, new URL("http://x/boards"), "/boards"))]) {
      expect(page).toContain('data-held-repo="alice/&lt;img');
      expect(page).not.toContain(SECRET);
    }
  });

  test("a repository name with markup is escaped", () => {
    const page = String(heldCard(readHeld(app, true, NOW)));
    expect(page).not.toContain(MARKUP);
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
