/** The gate minutes (#6426): check-slot minutes on merge-queue gates and on the other checks, clipped to the last hour and 6 h. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "../src/app.ts";
import { beginGate, endGate, KEEP_MS } from "../src/checks/gate_record.ts";
import { GATE_DEADLINE_MS } from "../src/checks/queue.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { readGateMinutes } from "../src/flow/gate_minutes.ts";
import { id } from "../src/kernel/id.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
/** The instant `m` minutes before NOW. */
const ago = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

let root = "";
let app: App;
const repos: Record<"public" | "private", string> = { public: "", private: "" };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-gate-minutes-"));
  app = createApp({ dataDir: root, port: 0 });
  const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  for (const visibility of ["public", "private"] as const) {
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: visibility, visibility, description: visibility });
    if (!repo.ok) throw new Error(repo.error);
    repos[visibility] = repo.value.id;
  }
});

afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const clear = (): void => {
  app.db.query("DELETE FROM check_gate").run();
  app.db.query("DELETE FROM run").run();
};

const check = (repoId: string, state: string, started: string | null, finished: string | null): void => {
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, state, started_at, finished_at) VALUES (?1, ?2, 'check', ?3, ?4, ?5)`)
    .run(id(), repoId, state, started, finished);
};

const gate = (repoId: string, started: string, finished: string | null): void => {
  const at = beginGate(app.db, repoId, undefined, "a".repeat(40), new Date(started));
  if (finished !== null) endGate(app.db, at, new Date(finished));
};

describe("gate minutes", () => {
  test("nothing checked is zero minutes", () => {
    clear();
    expect(readGateMinutes(app.db, NOW)).toEqual({ gate1h: 0, gate6h: 0, pull1h: 0, pull6h: 0 });
  });

  test("a check straddling the window's edge counts only its minutes inside it", () => {
    clear();
    // 70 → 50 min ago: 10 min inside the hour, all 20 inside 6 h.
    check(repos.public, "ok", ago(70), ago(50));
    // 400 → 340 min ago: nothing in the hour, 20 min inside 6 h (360 → 340).
    check(repos.public, "failed", ago(400), ago(340));
    // Over before either window opened.
    check(repos.public, "ok", ago(500), ago(450));
    expect(readGateMinutes(app.db, NOW)).toEqual({ gate1h: 0, gate6h: 0, pull1h: 10, pull6h: 40 });
  });

  test("a running check counts up to now; a queued one holds no slot", () => {
    clear();
    check(repos.public, "running", ago(12), null);
    check(repos.public, "running", ago(90), null); // 60 in the hour, 90 in 6 h
    check(repos.public, "queued", null, null);
    expect(readGateMinutes(app.db, NOW)).toEqual({ gate1h: 0, gate6h: 0, pull1h: 72, pull6h: 102 });
  });

  test("gates and pull checks are kept apart", () => {
    clear();
    gate(repos.public, ago(30), ago(15)); // 15
    gate(repos.public, ago(65), ago(55)); // 5 in the hour, 10 in 6 h
    gate(repos.public, ago(8), null); // running: 8
    check(repos.public, "ok", ago(20), ago(17)); // 3
    expect(readGateMinutes(app.db, NOW)).toEqual({ gate1h: 28, gate6h: 33, pull1h: 3, pull6h: 3 });
  });

  test("a gate a crash left open ends at the queue's deadline", () => {
    clear();
    const deadline = GATE_DEADLINE_MS / 60_000;
    gate(repos.public, ago(deadline + 100), null); // ended at 100 min ago: nothing in the hour
    gate(repos.public, ago(deadline + 30), null); // ended at 30 min ago: all of it in the hour
    expect(readGateMinutes(app.db, NOW)).toEqual({ gate1h: deadline, gate6h: 2 * deadline, pull1h: 0, pull6h: 0 });
  });

  test("publicOnly hides private repositories", () => {
    clear();
    gate(repos.public, ago(10), ago(5));
    gate(repos.private, ago(40), ago(20));
    check(repos.public, "ok", ago(4), ago(2));
    check(repos.private, "running", ago(30), null);
    expect(readGateMinutes(app.db, NOW, true)).toEqual({ gate1h: 5, gate6h: 5, pull1h: 2, pull6h: 2 });
    expect(readGateMinutes(app.db, NOW)).toEqual({ gate1h: 25, gate6h: 25, pull1h: 32, pull6h: 32 });
  });

  test("a gate's row is written open and closed once; a week-old row is pruned by the next", () => {
    clear();
    const at = beginGate(app.db, repos.public, undefined, "b".repeat(40), new Date(ago(5)));
    expect(readGateMinutes(app.db, NOW).gate1h).toBe(5);
    endGate(app.db, at, new Date(ago(2)));
    endGate(app.db, at, new Date(ago(0))); // a second end moves nothing
    expect(readGateMinutes(app.db, NOW).gate1h).toBe(3);
    beginGate(app.db, repos.public, undefined, "c".repeat(40), new Date(NOW.getTime() + KEEP_MS + 60_000));
    const left = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM check_gate").get();
    expect(left?.n).toBe(1);
  });
});
