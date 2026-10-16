/** The failure-domain map: the doc and the data agree, and the forge really says what the data quotes. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createRun } from "../src/core/runs.ts";
import { DOMAINS, domainRow } from "../src/kernel/domains.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { recordVerdict } from "../src/snapshot/verdict.ts";

let dataDir: string;
let app: App;
let repoId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-domains-"));
  app = createApp({ dataDir, port: 0 });
  const owner = await createUser(app.db, {
    username: "alice", email: "alice@forge.local", password: "a-good-passphrase",
  });
  if (!owner.ok) throw new Error("no owner");
  repoId = "repo-domains";
  app.db.query("INSERT INTO repo (id, owner_id, name) VALUES (?1, ?2, 'r')").run(repoId, owner.value.id);
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const said = (key: string): string[] => {
  const d = DOMAINS.find((x) => x.key === key)!;
  expect(d.says.length).toBeGreaterThan(0);
  return [...d.says];
};
const read = (now = Date.now()) =>
  vitals({ db: app.db, signals: app.signals, dataDir, now }).needs.join("\n");

test("seven domains, each complete", () => {
  expect(DOMAINS.map((d) => d.key)).toEqual([
    "compute", "state", "snapshots", "edge", "identity", "credential", "runner",
  ]);
  for (const d of DOMAINS) {
    expect(d.breaks && d.owner && d.name).toBeTruthy();
    expect(d.backMinutes).toBeGreaterThan(0);
    if (d.drill.name === null) expect(d.drill.why.trim()).not.toBe("");
  }
});

test("the doc's table is the data", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "DOMAINS.md"), "utf8");
  const rows = doc.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Domain") && !l.startsWith("| ---"));
  expect(rows).toEqual(DOMAINS.map(domainRow));
});

test("a nearly full disk says the state's words", () => {
  const v = vitals({ db: app.db, signals: app.signals, dataDir, diskFreeMin: 1.1 });
  for (const s of said("state")) expect(v.needs.join("\n")).toContain(s);
});

test("a red restore drill says the snapshot store's words", () => {
  recordVerdict(dataDir, {
    at: new Date().toISOString(), snapshotId: null, ms: 1, counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 },
    health: "unreached", verdict: "red", failedStep: "fetch", reason: "no bucket",
  });
  for (const s of said("snapshots")) expect(read()).toContain(s);
});

test("a stalled check queue and a silent run say the runner's words", () => {
  app.db.query("DELETE FROM run").run();
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const live = createRun(app.db, { repoId, kind: "check" });
  app.db
    .query("UPDATE run SET state='running', started_at=?2, heartbeat_at=?3 WHERE id=?1")
    .run(live.id, iso(now - 31 * 60_000), iso(now - 4 * 60_000));
  for (let i = 0; i < 2; i++) {
    const waiting = createRun(app.db, { repoId, kind: "check" });
    app.db.query("UPDATE run SET created_at=?2 WHERE id=?1").run(waiting.id, iso(now - 13 * 60_000));
  }
  const text = read(now);
  for (const s of said("runner")) expect(text).toContain(s);
  app.db.query("DELETE FROM run").run();
});

test("a domain with no words says nothing, and the doc says so", () => {
  const silent = DOMAINS.filter((d) => d.says.length === 0).map((d) => d.key);
  expect(silent).toEqual(["compute", "edge", "identity", "credential"]);
  expect(readFileSync(join(import.meta.dir, "..", "docs", "DOMAINS.md"), "utf8")).toContain("nothing yet");
});
