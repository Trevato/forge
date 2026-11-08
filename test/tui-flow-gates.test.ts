/** The Flow dialog lists each queued repository's last gates (#7320): verdict, how long ago, a red one's first failing test, `flaky` when it is. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { keepGateResult, recentGates, type GateResult } from "../src/checks/gate_result.ts";
import { createUser } from "../src/core/users.ts";
import { flowLines, gateLines } from "../src/tui/screens/flow.ts";

const NOW = new Date("2026-10-27T12:00:00Z");
const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

let app: App;
beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "tui-flow-gates-")), port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r1', ?1, 'svc', 'public')", [u.value.id]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r2', ?1, 'quiet', 'public')", [u.value.id]);
});
afterAll(() => app.close?.());

const gate = (over: Partial<GateResult>): GateResult => ({
  repoId: "r1",
  runId: "gate-abc",
  tipOid: "abc",
  pulls: [1],
  state: "green",
  passed: 10,
  failed: 0,
  failing: [],
  startedAt: at(12),
  finishedAt: at(10),
  ...over,
});

test("one green and one red gate: both lines, the red one names its failing test and file", () => {
  keepGateResult(app.db, "g1", gate({ pulls: [12, 13] }), NOW);
  keepGateResult(
    app.db,
    "g2",
    gate({ pulls: [14], state: "red", reason: "tests", passed: 9, failed: 1, failing: [{ name: "a > b", file: "test/a.test.ts", errors: ["boom"] }], finishedAt: at(5) }),
    NOW,
  );
  const queues = [
    { repo: "alice/svc", queued: 1, gating: 0, gates: 0, landedHour: 0, approvedToLanded: null },
    { repo: "alice/quiet", queued: 0, gating: 0, gates: 0, landedHour: 1, approvedToLanded: null },
  ];
  const lines = flowLines(app.db, NOW, [], { queues }, []);
  const svc = lines.findIndex((l) => l.startsWith("alice/svc"));
  expect(lines[svc + 1]).toBe("  #14 red · 5 minutes ago · a > b (test/a.test.ts)");
  expect(lines[svc + 2]).toBe("  #12 #13 green · 10 minutes ago");
  expect(lines[svc + 3]!.startsWith("alice/quiet")).toBe(true);
  expect(lines[svc + 4]).toBe("  no gates yet");
});

test("a test red in two gates that share no pull is marked flaky; cut off reads as two words", () => {
  keepGateResult(
    app.db,
    "g3",
    gate({ pulls: [20], state: "red", failed: 1, failing: [{ name: "a > b", file: "test/a.test.ts", errors: [] }], finishedAt: at(2) }),
    NOW,
  );
  keepGateResult(app.db, "g4", gate({ pulls: [21], state: "cut_off", finishedAt: at(1) }), NOW);
  const lines = gateLines(recentGates(app.db, "r1", 5), NOW.getTime(), 58);
  expect(lines).toEqual([
    "  #21 cut off · just now",
    "  #20 red · 2 minutes ago · a > b (test/a.test.ts) flaky",
    "  #14 red · 5 minutes ago · a > b (test/a.test.ts) flaky",
    "  #12 #13 green · 10 minutes ago",
  ]);
});

const svcRow = { repo: "alice/svc", queued: 1, gating: 0, gates: 0, landedHour: 0, approvedToLanded: null };
const quietRow = { repo: "alice/quiet", queued: 0, gating: 0, gates: 0, landedHour: 1, approvedToLanded: null };

test("the dialog shows at most five gates a repository", () => {
  for (let i = 0; i < 4; i++) keepGateResult(app.db, `g9${i}`, gate({ pulls: [30 + i] }), NOW);
  expect(recentGates(app.db, "r1", 100).length).toBeGreaterThan(5);
  const lines = flowLines(app.db, NOW, [], { queues: [svcRow, quietRow] }, []);
  const svc = lines.findIndex((l) => l.startsWith("alice/svc"));
  const quiet = lines.findIndex((l) => l.startsWith("alice/quiet"));
  expect(quiet - svc - 1).toBe(5);
  expect(lines.slice(svc + 1, quiet).every((l) => l.startsWith("  #"))).toBe(true);
});

test("an agent's dialog lists gates only for the queue rows it was handed: a private repository's never show", () => {
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r3', (SELECT owner_id FROM repo WHERE id = 'r1'), 'secret', 'private')");
  keepGateResult(app.db, "g99", gate({ repoId: "r3", pulls: [777], state: "red", failed: 1, failing: [{ name: "hidden > test", file: "test/hidden.test.ts", errors: [] }] }), NOW);
  const text = flowLines(app.db, NOW, [], { queues: [svcRow] }, []).join("\n");
  expect(text).toContain("alice/svc");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("#777");
  expect(text).not.toContain("hidden");
});

test("nothing queued: the dialog says so and lists no gates", () => {
  const lines = flowLines(app.db, NOW, [], { queues: [] }, []);
  expect(lines).toContain("Nothing queued, gating or landed in the last hour.");
  expect(lines).not.toContain("  no gates yet");
});
