/** The flow panel's "Last gates" card (#7508): both verdicts, pull links, the failing test, sealed and private pulls. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { keepGateResult, type GateResult } from "../src/checks/gate_result.ts";
import { createUser } from "../src/core/users.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
let app: App;
beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "panel-gates-")), port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r1', ?1, 'svc', 'public')", [u.value.id]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r2', ?1, 'hidden', 'private')", [u.value.id]);
  app.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, sealed) VALUES ('i1', 'r1', 14, 'pull', 'SECRET TITLE', '', ?1, 1)",
    [u.value.id],
  );
});
afterAll(() => app.close?.());

const gate = (over: Partial<GateResult>): GateResult => ({
  repoId: "r1", runId: "gate-abc", tipOid: "abc", pulls: [1], state: "green", passed: 10, failed: 0, failing: [],
  startedAt: ago(12), finishedAt: ago(10), ...over,
});
const draw = (kind: "owner" | "agent") => String(flowPanel(app, { kind }, new URL("http://x/boards"), "/boards"));

test("a green and a red gate: rows, pull links, the failing test and its first error, escaped", () => {
  keepGateResult(app.db, "g1", gate({ pulls: [12, 13] }));
  keepGateResult(
    app.db, "g2",
    gate({ pulls: [15], state: "red", failed: 1, failing: [{ name: "a <b> works", errors: ["boom <script>", "second"] }], finishedAt: ago(5) }),
  );
  const out = draw("agent");
  expect(out).toContain('id="gates"');
  expect(out).toContain('href="/alice/svc/pulls/12"');
  expect(out).toContain('href="/alice/svc/pulls/13"');
  expect(out).toContain('href="/alice/svc/pulls/15"');
  expect(out).toContain('data-gate="green"');
  expect(out).toContain('data-gate="red"');
  expect(out).toContain("a &lt;b&gt; works");
  expect(out).toContain("boom &lt;script&gt;");
  expect(out).not.toContain("second");
});

test("a sealed pull is never named or linked; a private repository's gates are the owner's alone", () => {
  keepGateResult(app.db, "g3", gate({ pulls: [14], finishedAt: ago(3) }));
  keepGateResult(app.db, "g4", gate({ repoId: "r2", pulls: [77], finishedAt: ago(1) }));
  const agent = draw("agent");
  expect(agent).toContain("a sealed pull");
  expect(agent).not.toContain("pulls/14");
  expect(agent).not.toContain("SECRET TITLE");
  expect(agent).not.toContain("pulls/77");
  expect(draw("owner")).toContain('href="/alice/hidden/pulls/77"');
});

test("a red or cut-off gate with a sealed pull shows the verdict alone", () => {
  keepGateResult(app.db, "g5", gate({ pulls: [14, 16], state: "red", failed: 1, failing: [{ name: "leaky test name", errors: ["leaky error"] }], finishedAt: ago(2) }));
  keepGateResult(app.db, "g6", gate({ pulls: [14], state: "cut_off", reason: "leaky reason", finishedAt: ago(2) }));
  const out = draw("owner");
  expect(out).not.toContain("leaky");
  expect(out).toContain('data-gate="red"');
});

test("a cut-off gate shows its reason, escaped", () => {
  keepGateResult(app.db, "g7", gate({ pulls: [40], state: "cut_off", reason: "slot <gone>", finishedAt: ago(1) }));
  const out = draw("owner");
  expect(out).toContain("cut off");
  expect(out).toContain("slot &lt;gone&gt;");
});

test("the card follows the reader: a non-owner reader never gets a private repository gate", () => {
  keepGateResult(app.db, "g8", gate({ repoId: "r2", pulls: [88], state: "red", failed: 1, failing: [{ name: "private-only test", errors: [] }], finishedAt: ago(0.5) }));
  expect(draw("owner")).toContain("private-only test");
  const other = draw("agent");
  expect(other).not.toContain("private-only test");
  expect(other).not.toContain("pulls/88");
});

test("only the newest ten are listed", () => {
  for (let i = 0; i < 12; i++) keepGateResult(app.db, `h${i}`, gate({ pulls: [100 + i], finishedAt: ago(-i - 1) }));
  const out = draw("owner");
  expect(out.match(/data-gate=/g)?.length).toBe(10);
  expect(out).not.toContain("No gate has run yet");
});
