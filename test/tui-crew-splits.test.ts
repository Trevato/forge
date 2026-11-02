/**
 * The crew scorecard in the terminal (#2682, #7936): an admin sees the
 * per-model, per-prompt, per-day and wasted cuts, each row carrying the
 * numbers `agentSplits`, `modelDays` and `wastedDays` answer; with no runs it
 * says so in one line; anyone else is neither offered the screen nor shown it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { modelDays } from "../src/core/model_days.ts";
import { agentSplits, claimRun, createRun, finishRun, noteRunProgress } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { wastedDays } from "../src/core/wasted_days.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { crewSplitsScreen } from "../src/tui/screens/crewsplits.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

/** A fresh forge with alice (admin), bob and smith (the agent), no runs. */
async function freshForge(): Promise<{ forge: Forge; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-tui-splits-"));
  const forge = createApp({ dataDir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["smith", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  return { forge, dataDir };
}

function boot(forge: Forge, username: string) {
  const user = getUserByName(forge.db, username)!;
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  app.start();
  const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  return {
    app,
    session,
    text: () => app.screen.toText(),
    lines: () => app.screen.toText().split("\n"),
    palette: async (word: string) => {
      key("k", true);
      for (const ch of word) key(ch);
      await settleApp(app);
    },
    enter: async () => {
      key("enter");
      await settleApp(app);
    },
    stop: () => app.stop(),
  };
}

async function openScorecard(forge: Forge) {
  const h = boot(forge, "alice");
  await h.palette("Crew scorecard");
  await h.enter();
  return h;
}

/** The one screen line naming `title`, which must also carry each of `parts`. */
function expectRow(lines: readonly string[], title: string, ...parts: string[]) {
  const line = lines.find((l) => l.includes(title));
  expect(line, title).toBeDefined();
  for (const part of parts) expect(line, `${title} / ${part}`).toContain(part);
}

const today = () => new Date().toISOString().slice(0, 10);

describe("with no agent runs", () => {
  let forge: Forge;
  let dataDir: string;
  beforeAll(async () => ({ forge, dataDir } = await freshForge()));
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the screen says so in one line, not an empty table", async () => {
    const h = await openScorecard(forge);
    const lines = h.lines();
    expect(lines.filter((l) => l.includes("No agent runs yet.")).length).toBe(1);
    expect(lines.some((l) => /\b(model|prompt|day|wasted) .*runs\b/.test(l))).toBe(false);
    h.stop();
  });
});

describe("over seeded runs", () => {
  let forge: Forge;
  let dataDir: string;
  beforeAll(async () => {
    ({ forge, dataDir } = await freshForge());
    const repoId = forge.db.query<{ id: string }, []>("SELECT id FROM repo LIMIT 1").get()?.id ?? "";
    // A fresh forge may have no repo, so the runs hang off repo "" — off for
    // the seed only, and put back as it was so the tests read a normal forge.
    const fk = forge.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 1;
    forge.db.run("PRAGMA foreign_keys = OFF");
    const agentId = getUserByName(forge.db, "smith")!.id;
    const seeds = [
      { model: "claude-opus-5-5", version: "v1", state: "ok", summary: "", cost: 0.1 },
      { model: "claude-opus-5-5", version: "v2", state: "failed", summary: "", cost: 0.2 },
      { model: "claude-sonnet-5-5", version: "v1", state: "ok", summary: "no changes pushed", cost: 0.4 },
      { model: "", version: "", state: "ok", summary: "", cost: 0.1 },
    ] as const;
    for (const s of seeds) {
      const run = createRun(forge.db, { repoId, kind: "agent", actorId: agentId });
      claimRun(forge.db, run.id);
      noteRunProgress(forge.db, run.id, { model: s.model, promptVersion: s.version });
      finishRun(forge.db, run.id, { state: s.state, summary: s.summary, costUsd: s.cost });
    }
    forge.db.run(`PRAGMA foreign_keys = ${fk ? "ON" : "OFF"}`);
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sees each split with the numbers the core answers", async () => {
    const byModel = agentSplits(forge.db, "model");
    const byPrompt = agentSplits(forge.db, "prompt_version");
    const days = modelDays(forge.db);
    const wasted = wastedDays(forge.db);
    // The seed is what the core sees.
    expect(byModel.map((r) => [r.key, r.runs, r.ok, r.failed]).sort()).toEqual([
      ["", 1, 1, 0],
      ["claude-opus-5-5", 2, 1, 1],
      ["claude-sonnet-5-5", 1, 1, 0],
    ]);
    expect(byPrompt.map((r) => [r.key, r.runs, r.ok, r.failed]).sort()).toEqual([
      ["", 1, 1, 0],
      ["v1", 2, 2, 0],
      ["v2", 1, 0, 1],
    ]);
    expect(days.length).toBe(3);
    expect(wasted.length).toBe(1);

    const h = await openScorecard(forge);
    const lines = h.lines();
    expect(lines.join("\n")).toContain("Agent runs per model, then per prompt version");
    for (const [label, blank, splits] of [["model", "default", byModel], ["prompt", "not recorded", byPrompt]] as const)
      for (const r of splits)
        expectRow(
          lines,
          `${label}: ${r.key === "" ? blank : r.key}`,
          `${r.runs} runs`,
          `${r.ok} landed`,
          `${r.failed} failed`,
          `$${r.spentUsd.toFixed(2)} spent`,
          `$${(r.spentUsd / r.runs).toFixed(2)} per run`,
        );
    for (const d of days)
      expectRow(lines, `day ${d.day}: ${d.model === "" ? "default" : d.model}`, `${d.runs} runs`, `${d.landed} landed`, `$${d.spentUsd.toFixed(2)} spent`);
    for (const w of wasted)
      expectRow(lines, `wasted ${w.day}`, `${w.wasted} of ${w.runs} runs`, `$${w.spentUsd.toFixed(2)} spent`);

    // And the numbers themselves, so a wrong core cannot agree with a wrong screen.
    expectRow(lines, "model: claude-opus-5-5", "2 runs", "1 landed", "1 failed", "$0.30 spent", "$0.15 per run");
    expectRow(lines, "model: claude-sonnet-5-5", "1 runs", "1 landed", "0 failed", "$0.40 spent", "$0.40 per run");
    expectRow(lines, "model: default", "1 runs", "1 landed", "0 failed", "$0.10 spent", "$0.10 per run");
    expectRow(lines, "prompt: v1", "2 runs", "2 landed", "0 failed", "$0.50 spent", "$0.25 per run");
    expectRow(lines, "prompt: v2", "1 runs", "0 landed", "1 failed", "$0.20 spent", "$0.20 per run");
    expectRow(lines, "prompt: not recorded", "1 runs", "1 landed", "0 failed", "$0.10 spent", "$0.10 per run");
    // A day's "landed" counts merged pulls, and the seed merges none.
    expectRow(lines, `day ${today()}: claude-opus-5-5`, "2 runs", "0 landed", "$0.30 spent");
    expectRow(lines, `wasted ${today()}`, "1 of 4 runs", "$0.40 spent");
    h.stop();
  });

  test("a non-admin's palette does not offer the scorecard; an admin's does", async () => {
    const admin = boot(forge, "alice");
    await admin.palette("Crew scorecard");
    expect(admin.text()).toContain("agent runs per model and per prompt version");
    admin.stop();
    const h = boot(forge, "bob");
    await h.palette("Crew scorecard");
    expect(h.text()).not.toContain("agent runs per model and per prompt version");
    h.stop();
  });

  test("the screen itself refuses a non-admin: the gate line, and no rows", async () => {
    const h = boot(forge, "bob");
    h.app.ctx.push(crewSplitsScreen(h.session, h.app.ctx));
    await settleApp(h.app);
    const text = h.text();
    expect(text).toContain("The crew scorecard is read by a forge admin.");
    expect(text).not.toMatch(/\b(model|prompt|day|wasted) .*runs\b/);
    expect(text).not.toContain("claude-opus-5-5");
    h.stop();
  });
});
