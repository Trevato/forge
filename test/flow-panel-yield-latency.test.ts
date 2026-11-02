/** The flow panel's build-yield and review-latency lines (#6589). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

let dir: string;
let app: App;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "forge-panel-yl-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
  const b = await createUser(app.db, { username: "builder", email: "b@forge.test", agent: true, origin: "agent" });
  if (!u.ok || !b.ok) throw new Error("seed");
  createAgentRow(app.db, { userId: b.value.id, brief: "builder." });
  let n = 0;
  const seed = (name: string, vis: string, openedMin: number, reviewedMin: number) => {
    const rid = id();
    app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)`).run(rid, u.value.id, name, vis);
    addCrew(app.db, rid, b.value.id, u.value.id);
    const iid = id();
    const number = ++n;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, ?5)`).run(iid, rid, number, b.value.id, ago(openedMin));
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', '', ?3)`).run(iid, `b/${number}`, ago(1));
    app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, 'approved', ?4)`).run(id(), iid, u.value.id, ago(reviewedMin));
    app.db.query(`INSERT INTO run (id, repo_id, kind, branch, state, reason, started_at, finished_at) VALUES (?1, ?2, 'agent', ?3, 'ok', '', ?4, ?5)`).run(id(), rid, `b/${number}`, ago(openedMin + 5), ago(openedMin - 5));
    app.db.query(`INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'pull.opened', ?2, ?3, ?4)`).run(id(), rid, JSON.stringify({ number }), ago(openedMin));
  };
  seed("pub", "public", 180, 60); // 2 h to first review
  seed("priv", "private", 240, 0); // 4 h
});
afterEach(() => {
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const draw = (kind: "owner" | "agent") => String(flowPanel(app, { kind }, new URL("http://x/boards"), "/boards"));

test("the owner sees yield and latency across all repositories", () => {
  const page = draw("owner");
  expect(page).toContain("Build yield: 2 runs finished, 2 pushed, 2 landed (24 h)");
  expect(page).toContain("First review: median 3 h over 2 pulls (24 h)");
});

test("an agent reader gets public repositories alone", () => {
  const page = draw("agent");
  expect(page).toContain("Build yield: 1 run finished, 1 pushed, 1 landed (24 h)");
  expect(page).toContain("First review: median 2 h over 1 pull (24 h)");
});

test("the terminal's Flow dialog says both lines in the same words", () => {
  const owner = flowLines(app.db, new Date(), []).join(" ");
  expect(owner).toContain("Build yield: 2 runs finished, 2 pushed, 2 landed (24 h)");
  expect(owner).toContain("First review: median 3 h over 2 pulls (24 h)");
  const agent = flowLines(app.db, new Date(), [], { queues: [] }).join(" ");
  expect(agent).toContain("Build yield: 1 run finished");
  expect(agent).toContain("First review: median 2 h over 1 pull (24 h)");
});
