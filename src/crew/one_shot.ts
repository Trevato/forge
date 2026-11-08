/**
 * One short question to the model, answered in one turn with no tools: no
 * shell, no files, no MCP server. It runs on the asker's own account as a
 * conversation turn does (`pickSubscription`, their daily ceiling). Its cap is
 * booked in `one_shot_spend` before it starts, so `daySpent` counts it while it
 * runs, then set to what it cost, which is also added to the subscription's
 * spend. Never throws; every ending is a `Result`.
 */

import type { App } from "../app.ts";
import { dailyLeft } from "../core/account_ceiling.ts";
import { PLATFORM, pickSubscription } from "../core/subscriptions.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { runClaude } from "./claude.ts";
import { conversationOptions, sessionsDir, turnDir } from "./conversation.ts";
import { isRateLimited } from "./limits.ts";
import { credentialEnv } from "./runner.ts";
import { sandboxPolicy } from "./sandbox.ts";

/** The most one such question may spend, in dollars. */
export const ONE_SHOT_USD = 0.05;
/** The longest one may take. */
export const ONE_SHOT_MS = 60_000;

export type OneShotRefusal = "off" | "no_account" | "resting" | "failed";

export async function oneShot(app: App, userId: string, system: string, prompt: string): Promise<Result<string, OneShotRefusal>> {
  const options = conversationOptions(app);
  if (options === undefined) return err("off");
  const now = new Date();
  const runId = id();
  const picked = pickSubscription(app.db, app.config.dataDir, { repoId: "", ownerId: userId, agentId: "" }, now, { runId, usd: ONE_SHOT_USD });
  if (picked.kind === "none") return err("no_account");
  if (picked.kind === "resting") return err("resting");
  const left = dailyLeft(app.db, userId, now);
  const budget = Math.min(ONE_SHOT_USD, options.budgetUsd, picked.kind === "ready" ? (picked.capUsd ?? Infinity) : Infinity, left ?? Infinity);
  if (budget <= 0) return err("resting");
  const subscriptionId = picked.kind === "ready" ? picked.subscription.id : PLATFORM;
  app.db
    .query("INSERT INTO one_shot_spend (id, user_id, subscription_id, cost_usd, at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .run(runId, userId, subscriptionId, budget, now.toISOString());
  let costUsd = budget;
  try {
    const outcome = await runClaude({
      binary: options.binary,
      cwd: turnDir(app.config.dataDir),
      prompt,
      appendSystemPrompt: system,
      model: options.model,
      budgetUsd: budget,
      env: { ...credentialEnv(picked), CLAUDE_CONFIG_DIR: sessionsDir(app.config.dataDir, options.configDir) },
      sandbox: sandboxPolicy({ dataDir: app.config.dataDir, agentName: "one-shot", urls: [], enforced: false, runId }),
      label: "one-shot",
      timeoutMs: ONE_SHOT_MS,
      log: () => {},
      signal: options.signal,
      mcp: { config: JSON.stringify({ mcpServers: {} }), allow: [] },
    });
    costUsd = outcome.costUsd ?? 0;
    app.db.query("UPDATE subscription SET spent_usd = spent_usd + ?2 WHERE id = ?1").run(subscriptionId, costUsd);
    if (isRateLimited(outcome)) return err("resting");
    return outcome.ok && outcome.result.trim() !== "" ? ok(outcome.result) : err("failed");
  } catch (error) {
    app.log.warn("one-shot failed", { error: String(error) });
    return err("failed");
  } finally {
    // A run that threw keeps its cap as its cost: what it spent is not known, and the ceiling errs high.
    app.db.query("UPDATE one_shot_spend SET cost_usd = ?2 WHERE id = ?1").run(runId, costUsd);
  }
}
