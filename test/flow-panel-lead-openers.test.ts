/** The flow panel's lead-time and openers lines (#6497). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

let dir: string;
let app: App;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "forge-panel-lo-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, { username: "scout", email: "s@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
  if (!u.ok) throw new Error(u.error);
  const uid = u.value.id;
  const repo = (name: string, vis: string) => {
    const rid = id();
    app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)`).run(rid, uid, name, vis);
    return rid;
  };
  let n = 0;
  const pull = (rid: string, openedMin: number, mergedMin: number | null) => {
    const iid = id();
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, ?5)`)
      .run(iid, rid, ++n, uid, ago(openedMin));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', '', ?3)`)
      .run(iid, `b/${n}`, mergedMin === null ? null : ago(mergedMin));
  };
  const pub = repo("pub", "public");
  const priv = repo("priv", "private");
  pull(pub, 180, 10);
  pull(priv, 30, 5);
  pull(priv, 20, null);
});
afterEach(() => {
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const draw = (kind: "owner" | "agent") => String(flowPanel(app, { kind }, new URL("http://x/boards"), "/boards"));

test("the owner sees both lines across all repositories, names linked", () => {
  const page = draw("owner");
  expect(page).toContain("time to land:");
  expect(page).toMatch(/data-median-hours>\d/);
  expect(page).toMatch(/data-max-hours>\d/);
  expect(page).toContain(`<a href="/scout">scout</a> 2 (0 flow)`);
});

test("a non-admin reads public repositories alone", () => {
  const page = draw("agent");
  expect(page).toMatch(/opened in the last hour:\s+no pulls/);
  expect(page).toContain("data-median-hours>2.8h<");
  expect(page).toContain("data-max-hours>2.8h<");
  expect(page).not.toContain("(0 flow)");
});

test("the terminal's Flow dialog says both lines too, public-only for an agent", () => {
  const owner = flowLines(app.db, new Date(), []).join(" ");
  expect(owner).toContain("Time to land: median");
  expect(owner).toContain("scout: 2 pulls, 0 for flow");
  const agent = flowLines(app.db, new Date(), [], { queues: [] }).join(" ");
  expect(agent).toContain("Time to land: median 2.8 h, slowest 2.8 h");
  expect(agent).toContain("Opened in the last hour: no pulls");
});
