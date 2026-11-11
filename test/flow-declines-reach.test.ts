/** Declined runs reach /flow's panel and the flow tool's answer (#10862). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

let dir: string;
let app: App;
let owner: string;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function seed(name: string, vis: string, n: number, summary: string, min: number): string {
  const rid = id();
  const iid = id();
  const run = id();
  app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)`).run(rid, owner, name, vis);
  app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id) VALUES (?1, ?2, ?3, 'issue', 't', '', ?4)`).run(iid, rid, n, owner);
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, state, reason, summary, started_at, finished_at) VALUES (?1, ?2, 'agent', ?3, 'ok', '', ?4, ?5, ?6)`)
    .run(run, rid, iid, summary, ago(min + 5), ago(min));
  return run;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "forge-declines-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
  if (!u.ok) throw new Error("seed");
  owner = u.value.id;
});
afterEach(() => {
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const draw = (kind: "owner" | "agent") => String(flowPanel(app, { kind }, new URL("http://x/boards"), "/boards"));

test("nothing shows when nothing was declined", () => {
  seed("pub", "public", 1, "Shipped it", 10);
  expect(draw("owner")).not.toContain('id="declines"');
  expect(flowFor(app, { kind: "owner" }).declines.says).toBe("");
});

test("the panel and the flow answer count declined runs by reason, linked to the runs", () => {
  const a = seed("pub", "public", 1, "Declined: already done on main in abc", 10);
  seed("pub2", "public", 1, "Declined: task unclear", 20);
  seed("priv", "private", 1, "Declined: already done on main", 30);
  seed("old", "public", 2, "Declined: already done on main", 60 * 25);
  const page = draw("owner");
  expect(page).toContain('id="declines"');
  expect(page).toContain("2 already on main");
  expect(page).toContain("1 other");
  expect(page).toContain(`href="/alice/pub/runs/${a}"`);
  const body = flowFor(app, { kind: "owner" }).declines;
  expect(body.groups.done_on_main.count).toBe(2);
  expect(body.groups.other.count).toBe(1);
  expect(body.runs.done_on_main.map((r) => r.runId)).toContain(a);
  // An agent reader gets public repositories alone.
  expect(flowFor(app, { kind: "agent" }).declines.groups.done_on_main.count).toBe(1);
  expect(draw("agent")).not.toContain("alice/priv");
});

test("the terminal Flow screen shows the declines line, public only for an agent", async () => {
  const { flowLines } = await import("../src/tui/screens/flow.ts");
  expect(flowLines(app.db, new Date(), [], undefined, []).join("\n")).not.toContain("Declined in 24 h");
  seed("pub", "public", 1, "Declined: already done on main", 10);
  seed("priv", "private", 1, "Declined: task unclear", 20);
  const admin = flowLines(app.db, new Date(Date.now() + 1), [], undefined, []).join("\n");
  expect(admin).toContain("Declined in 24 h: 1 already on main");
  expect(admin).toContain("1 other");
  const agent = flowLines(app.db, new Date(Date.now() + 2), [], { queues: [] }, []).join("\n");
  expect(agent).toContain("1 already on main");
  expect(agent).not.toContain("1 other");
});
