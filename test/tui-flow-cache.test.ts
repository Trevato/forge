/** The Flow screen reads the panel cache /boards fills (#6975): no reader runs again, the figures are the page's, an agent's screen is public-only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { panelFigures } from "../src/flow/panel_cache.ts";
import { buildYieldSays } from "../src/flow/build_yield.ts";
import { leadTimeSays, flowLines } from "../src/tui/screens/flow.ts";
import { reviewLatencySays } from "../src/flow/review_latency.ts";
import { pileSays } from "../src/flow/pile.ts";

let app: App;
let agentId: string;
beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "tui-flow-cache-")), port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "scout", email: "scout@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  agentId = b.value.id;
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [agentId]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('priv', ?1, 'priv', 'private')", [u.value.id]);
});
afterAll(() => app.close?.());

/** How many times the openers reader ran during `fn`: only the panel's readers call it, once per run. */
function panelRuns(fn: () => void): number {
  let n = 0;
  const q = app.db.query.bind(app.db);
  const orig = app.db.query;
  (app.db as unknown as { query: unknown }).query = (sql: string) => {
    if (sql.includes("WITH RECURSIVE flow")) n++;
    return q(sql as never);
  };
  try {
    fn();
  } finally {
    (app.db as unknown as { query: unknown }).query = orig;
  }
  return n;
}

let tick = 0;
const write = () => app.db.run("UPDATE user SET display_name = ?1", [`n${++tick}`]);

test("opened right after a /boards load, the screen runs none of the panel's readers", () => {
  const now = new Date();
  write();
  expect(panelRuns(() => panelFigures(app.db, "owner", now))).toBe(1); // what /boards does, cold
  expect(panelRuns(() => flowLines(app.db, now, [], undefined, []))).toBe(0); // the screen after it
  write();
  expect(panelRuns(() => flowLines(app.db, now, [], undefined, []))).toBe(1); // nothing kept: the screen fills it
});

test("the screen says the page's figures", () => {
  const now = new Date();
  const fig = panelFigures(app.db, "owner", now);
  const text = flowLines(app.db, now, [], undefined, []).join("\n");
  expect(text).toContain(leadTimeSays(fig.lead));
  expect(text).toContain(buildYieldSays(fig.yielded));
  expect(text).toContain(reviewLatencySays(fig.latency));
  expect(text).toContain(pileSays(fig.pile));
});

test("an agent's screen is the public-only set, kept apart from the admin's", () => {
  // an agent's pull in the private repository, opened half an hour ago
  const ago = new Date(Date.now() - 1_800_000).toISOString();
  app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES ('p1', 'priv', 1, 'pull', 't', '', ?1, 'open', ?2)", [agentId, ago]);
  app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES ('p1', 'main', 'b', '', 'h')");
  const now = new Date();
  const owner = flowLines(app.db, now, [], undefined, []).join("\n");
  const agent = flowLines(app.db, now, [], { queues: [] }, []).join("\n");
  expect(owner).toContain("scout: 1 pull");
  expect(agent).not.toContain("scout");
  expect(agent).toContain("Opened in the last hour: no pulls.");
  expect(panelFigures(app.db, "agent", now)).not.toBe(panelFigures(app.db, "owner", now));
  // asked again, each still gets its own
  expect(flowLines(app.db, now, [], undefined, []).join("\n")).toContain("scout: 1 pull");
  expect(flowLines(app.db, now, [], { queues: [] }, []).join("\n")).not.toContain("scout");
});
