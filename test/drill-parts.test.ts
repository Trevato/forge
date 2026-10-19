/**
 * The drill times download, decompress, open and migrate (#2748): a red
 * card names them in words, and a slow download is named the slowest part.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { describeTimes, runDrill, timeByPart } from "../src/snapshot/drill.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { failedSentence, slowSentence } from "../src/snapshot/verdict.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-drillparts-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  await takeSnapshot(
    { db: app.db, dataDir: root, reposRoot: app.reposRoot, version: "t" },
    dirStore(join(root, "store")),
    new Date("2026-10-18T08:00:00Z"),
  );
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a fake store with a slow download gives a card naming download the slowest", async () => {
  const inner = dirStore(join(root, "store"));
  const slow: Store = {
    ...inner,
    get: async (key) => {
      await new Promise((r) => setTimeout(r, 60));
      return inner.get(key);
    },
  };
  const r = await runDrill({
    store: slow,
    dataDir: join(root, "drill-data"),
    boot: async () => ({ ok: false, reason: "health never answered" }),
  });
  expect(r.verdict).toBe("red");
  const parts = r.phases.map((p) => p.phase);
  expect(parts).toContain("files");
  expect(parts.slice(-2)).toEqual(["open", "boot"]);
  const card = failedSentence(r)!;
  expect(card).toContain("health never answered");
  expect(card).toMatch(/download \d+ (ms|s)/);
  expect(card).toContain("download was the slowest");
  expect(card).toContain("migrate");
});

test("times read in words, longest first, with the minutes rounded to about", () => {
  expect(
    describeTimes([
      { phase: "manifest", ms: 1_000 },
      { phase: "files", ms: 479_000 },
      { phase: "unpack", ms: 40_000 },
      { phase: "open", ms: 2_000 },
      { phase: "boot", ms: 3_000 },
    ]),
  ).toBe("download about 8 min, decompress 40 s, start and migrate 3 s, open 2 s; download was the slowest");
  expect(describeTimes([])).toBe("");
});

test("every phase has its plain word: clone for bundles, key kept apart, boot as migrate", () => {
  const parts = timeByPart([
    { phase: "bundles", ms: 9_000 },
    { phase: "key", ms: 1 },
    { phase: "boot", ms: 5_000 },
  ]);
  expect(parts).toEqual([
    { part: "clone", ms: 9_000 },
    { part: "start and migrate", ms: 5_000 },
    { part: "key", ms: 1 },
  ]);
  expect(describeTimes([{ phase: "key", ms: 1 }])).toBe("");
});

test("the board's slow line says migrate, not boot", () => {
  const r = {
    at: "2026-10-18T09:00:00.000Z", snapshotId: "s", ms: 9 * 60_000,
    counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 },
    health: "ok" as const, verdict: "green" as const, failedStep: null,
    phases: [{ phase: "files" as const, ms: 1_000 }, { phase: "boot" as const, ms: 8 * 60_000 }],
    budgetMs: 10 * 60_000, reason: null,
  };
  expect(slowSentence(r)).toContain("start and migrate took 8 min");
});
