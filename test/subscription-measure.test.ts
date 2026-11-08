/** The provider's measure of a window (#8960): read from the session's event, kept, and read back only while its window is open. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { readForgeUsage } from "../src/actions/usage.ts";
import { createApp, type App } from "../src/app.ts";
import { measureFor, measureOf, noteMeasure, type Measure } from "../src/core/measure.ts";
import type { Repo } from "../src/core/repos.ts";
import { addSubscription, setGrants } from "../src/core/subscriptions.ts";
import type { User } from "../src/core/users.ts";
import { runClaude } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dir: string;
let app: App;
let sub: string;
const NOW = new Date("2026-11-02T12:00:00Z");
const reset = Math.floor(NOW.getTime() / 1000) + 86_400;
const event = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-measure-"));
  app = createApp({ dataDir: dir, port: 0 });
  const added = addSubscription(app.db, dir, { name: "main", token: "sk-ant-oat01-measure-1" });
  if (!added.ok) throw new Error(added.error);
  sub = added.value.id;
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a rate-limit event carries a window, a percent used and a reset", () => {
  expect(measureOf(event({ rateLimitType: "seven_day", utilization: 0.42, resetsAt: reset }), NOW)).toEqual({
    window: "week",
    usedPct: 42,
    resetsAt: new Date(reset * 1000).toISOString(),
    observedAt: NOW.toISOString(),
  });
  expect(measureOf(event({ rateLimitType: "five_hour", utilization: 1, resetsAt: reset }), NOW)?.window).toBe("5h");
});

test("an event without a usable measure is no measure", () => {
  expect(measureOf(event({ rateLimitType: "seven_day", resetsAt: reset }), NOW)).toBeUndefined();
  expect(measureOf(event({ rateLimitType: "seven_day", utilization: 1.5, resetsAt: reset }), NOW)).toBeUndefined();
  expect(measureOf(event({ rateLimitType: "seven_day", utilization: 0.2 }), NOW)).toBeUndefined();
  expect(measureOf(event({ rateLimitType: "overage", utilization: 0.2, resetsAt: reset }), NOW)).toBeUndefined();
  expect(measureOf({ type: "assistant" }, NOW)).toBeUndefined();
});

test("the newest word replaces the last, and a window that has reset is unknown", () => {
  const m = measureOf(event({ rateLimitType: "seven_day", utilization: 0.3, resetsAt: reset }), NOW)!;
  noteMeasure(app.db, sub, m);
  noteMeasure(app.db, sub, { ...m, usedPct: 35 });
  expect(measureFor(app.db, sub, "week", NOW)?.usedPct).toBe(35);
  expect(measureFor(app.db, sub, "5h", NOW)).toBeNull();
  expect(measureFor(app.db, sub, "week", new Date((reset + 1) * 1000))).toBeNull();
});

test("an unknown subscription is not given a measure", () => {
  const m = measureOf(event({ rateLimitType: "seven_day", utilization: 0.3, resetsAt: reset }), NOW)!;
  noteMeasure(app.db, "nobody", m);
  expect(measureFor(app.db, "nobody", "week", NOW)).toBeNull();
});

// A rate_limit_event as Claude Code's stream-json writes it. NOT a recording:
// this sandbox cannot run Claude Code, so the shape is the documented one
// (`rate_limit_info`: status, resetsAt in unix seconds, rateLimitType, and
// `utilization` only when the provider sends it). Replace with a recorded line.
const WARNING = (at: number) =>
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":${at},"rateLimitType":"seven_day","utilization":0.75},"uuid":"u1","session_id":"s1"}`;
const PLAIN = (at: number) =>
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":${at},"rateLimitType":"five_hour"},"uuid":"u2","session_id":"s1"}`;

test("the fixture lines: one carries a measure, the status-only one carries none", () => {
  expect(measureOf(JSON.parse(WARNING(reset)), NOW)?.usedPct).toBe(75);
  expect(measureOf(JSON.parse(PLAIN(reset)), NOW)).toBeUndefined();
});

test("a rate_limit_event line reaches onMeasure and nothing else in the stream parser", async () => {
  const fake = join(dir, "fake-claude");
  const future = Math.floor(Date.now() / 1000) + 86_400;
  writeFileSync(
    fake,
    `#!/bin/sh
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
echo '${WARNING(future)}'
echo '${PLAIN(future)}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
`,
  );
  chmodSync(fake, 0o755);
  const seen: Measure[] = [];
  const lines: string[] = [];
  const outcome = await runClaude({
    binary: fake,
    cwd: dir,
    prompt: "go",
    appendSystemPrompt: "",
    budgetUsd: 1,
    env: {},
    sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
    timeoutMs: 10_000,
    log: (l) => lines.push(l),
    signal: new AbortController().signal,
    onMeasure: (m) => seen.push(m),
  });
  expect(outcome.ok).toBe(true);
  expect(seen.map((m) => [m.window, m.usedPct])).toEqual([["week", 75]]);
  expect(lines.join("\n")).not.toContain("rate_limit");
});

describe("the usage headroom", () => {
  let repo: Repo;
  let admin: User;
  const week = () => readForgeUsage(app, admin, NOW).subscriptions.find((s) => s.subscription === "main")!.headroom.find((w) => w.window === "week");
  const clear = () => app.db.query("DELETE FROM subscription_measure").run();

  beforeAll(async () => {
    const a = await seedAdmin(app, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
    if (!a.ok) throw new Error("admin");
    admin = a.value;
    const made = await createRepo(app, admin, { name: "svc", visibility: "private" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
    setGrants(app.db, repo.id, "", [sub]);
  });

  test("prefers the provider's measure over the ledger's inference", () => {
    clear();
    noteMeasure(app.db, sub, { window: "week", usedPct: 62.4, resetsAt: new Date(reset * 1000).toISOString(), observedAt: NOW.toISOString() });
    expect(week()).toEqual({ window: "week", pct: 38, resetsAt: new Date(reset * 1000).toISOString() });
  });

  test("falls back when there is no measure, or its window has reset", () => {
    clear();
    const none = week();
    expect(none?.pct ?? null).toBeNull();
    expect(none?.resetsAt ?? null).not.toBe(new Date(reset * 1000).toISOString());
    noteMeasure(app.db, sub, { window: "week", usedPct: 62.4, resetsAt: new Date(NOW.getTime() - 1000).toISOString(), observedAt: NOW.toISOString() });
    expect(week()?.pct ?? null).toBeNull();
  });
});
