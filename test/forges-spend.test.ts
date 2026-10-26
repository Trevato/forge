/**
 * The crew's spend on /forges (#5866): a heartbeat may carry spendTodayUsd
 * and ceilingUsd, a bad value drops the field and not the beat, and the row
 * says "$3.20 of $10 today", attention-toned from 80%, "ceiling reached" at 100%.
 */

import { describe, expect, test } from "bun:test";
import { parseBeat, spendReport } from "../src/spawn/heartbeat.ts";
import { spendWords, type ClientRow } from "../src/spawn/clients.ts";
import { createApp } from "../src/app.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";

const beat = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "maria", at: Date.now(), version: "0.7.114", openProposals: 1, children: 0, ...o });

const row = (spendTodayUsd: number | null, ceilingUsd: number | null) =>
  ({ spendTodayUsd, ceilingUsd }) as ClientRow;

describe("a beat's spend", () => {
  test("with spend and a cap", () => {
    expect(parseBeat(beat({ spendTodayUsd: 3.2, ceilingUsd: 10 }))).toMatchObject({ spendTodayUsd: 3.2, ceilingUsd: 10 });
    expect(parseBeat(beat({ spendTodayUsd: 0, ceilingUsd: null }))).toMatchObject({ spendTodayUsd: 0, ceilingUsd: null });
  });
  test("without spend", () => {
    const b = parseBeat(beat());
    expect(b?.name).toBe("maria");
    expect(b).not.toHaveProperty("spendTodayUsd");
    expect(b).not.toHaveProperty("ceilingUsd");
  });
  test("a negative or non-numeric value drops the field, not the beat", () => {
    for (const bad of [-1, "3", {}, true, 1e9]) {
      const b = parseBeat(beat({ spendTodayUsd: bad, ceilingUsd: bad }));
      expect(b?.name).toBe("maria");
      expect(b).not.toHaveProperty("spendTodayUsd");
      expect(b).not.toHaveProperty("ceilingUsd");
    }
    const half = parseBeat(beat({ spendTodayUsd: 2, ceilingUsd: -5 }));
    expect(half).toMatchObject({ spendTodayUsd: 2 });
    expect(half).not.toHaveProperty("ceilingUsd");
  });
  test("a child reports what its crew spent today and the daily ceiling", async () => {
    const app = createApp({
      dataDir: mkdtempSync(join(tmpdir(), "forge-spend-")),
      url: "https://x.test",
      port: 0,
      crewCeilingUsd: 10,
    });
    expect(spendReport(app)).toEqual({ spendTodayUsd: 0, ceilingUsd: 10 });
    const user = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!user.ok) throw new Error(user.error);
    const repo = await createRepo(app, user.value, { name: "one", visibility: "private" });
    if (!repo.ok) throw new Error("repo");
    const run = createRun(app.db, { repoId: repo.value.id, kind: "agent" });
    app.db.query("UPDATE run SET cost_usd = 3.204 WHERE id = ?1").run(run.id);
    expect(spendReport(app).spendTodayUsd).toBe(3.2);
    const bare = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-spend-")), url: "https://x.test", port: 0 });
    expect(spendReport(bare).ceilingUsd).toBeNull();
  });
});

describe("the row's words", () => {
  test("says nothing when the child has not reported", () => {
    expect(spendWords(row(null, 10))).toBeNull();
  });
  test("50%: plain", () => {
    expect(spendWords(row(5, 10))).toEqual({ words: "$5.00 of $10 today", warn: false });
    expect(spendWords(row(3.2, 10))?.words).toBe("$3.20 of $10 today");
  });
  test("85%: attention", () => {
    expect(spendWords(row(8.5, 10))).toEqual({ words: "$8.50 of $10 today", warn: true });
  });
  test("100%: ceiling reached", () => {
    expect(spendWords(row(10, 10))).toEqual({ words: "$10.00 of $10 today · ceiling reached", warn: true });
  });
  test("no cap: just the sum", () => {
    expect(spendWords(row(4, null))).toEqual({ words: "$4.00 today", warn: false });
  });
});
