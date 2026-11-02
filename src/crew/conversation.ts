/**
 * A person's message becomes one agent turn (#7651): one `runClaude`, resumed
 * from the conversation's stored session, with no clone and no shell — only
 * this forge's `/mcp`, reached with a `via` token of that person, so the
 * agent can do what they can and no more (`core/via_token.ts`, the fence in
 * `core/fence.ts`). Its words are stored as agent turns, its calls as tool
 * turns, its spend on the person's account like any run's.
 *
 * A message sent while a turn runs is steered into it (`steerRun`). A turn
 * the forge's restart cut short is found at boot (`resumeInterrupted`, as
 * `interrupted.ts` finds runs) and resumed once from its session. Resuming
 * repeats no write: a held write is single-use (`core/fence.ts`), and the
 * resumed turn is told to check what is done before doing anything.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { dailyLeft } from "../core/account_ceiling.ts";
import { appendTurn, openConversation, removeTurn, setClaudeSession, type Conversation } from "../core/conversations.ts";
import { WORDS_MAX } from "../core/fence.ts";
import { PLATFORM, pickSubscription, type Pick } from "../core/subscriptions.ts";
import { getUserById } from "../core/users.ts";
import { mintViaToken, VIA_TOKEN_MAX_MS } from "../core/via_token.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { appendRunLog } from "../runs/log.ts";
import { runClaude, type ClaudeOutcome } from "./claude.ts";
import { CONVERSATION_BRIEF } from "./conversation_brief.ts";
import { isRateLimited, takeLimit, whenText } from "./limits.ts";
import { credentialEnv, listenForSteer, steerRun } from "./runner.ts";
import { sandboxPolicy } from "./sandbox.ts";

export interface ConversationOptions {
  readonly binary: string;
  /** Where this forge answers on this machine: `/mcp` is reached here. */
  readonly localUrl: string;
  /** Most a turn may spend, in dollars. */
  readonly budgetUsd: number;
  /** Most a turn may take; the token lives that long (an hour at most). */
  readonly timeoutMs: number;
  readonly model?: string | undefined;
  readonly configDir?: string | undefined;
  /** Stops turns for a restart: their rows stay `running` for the next boot. */
  readonly signal: AbortSignal;
  /** Most turns running at once across the forge; `TURNS_LIVE_MAX` when unset. */
  readonly liveMax?: number | undefined;
}

/**
 * Most turns running at once across the forge. Each is one `claude` process
 * on this machine, so the cap bounds the processes the people can start
 * together; a message past it is told to wait (`busy`), a steer into a
 * running turn starts nothing and is never counted.
 */
export const TURNS_LIVE_MAX = 4;

/** The MCP server's name in the agent's config, and so the prefix of its tools. */
export const MCP_SERVER = "forge";

const configured = new WeakMap<App, ConversationOptions>();

/** The forge's conversation settings, set once at boot; the doors read them. */
export const configureConversation = (app: App, options: ConversationOptions): void => {
  configured.set(app, options);
};

/** The settings the doors answer with; undefined where the crew is off. */
export const conversationOptions = (app: App): ConversationOptions | undefined => configured.get(app);

/** Whether a turn of this person's conversation is running now. */
export const turnRunning = (app: App, userId: string): boolean => live.has(openConversation(app.db, userId).id);

/** The one line the person sees when a restart cut their answer short. */
export const RESUMED_LINE = "The forge restarted while I was answering; I am picking it up where I stopped.";

const RESUME_PROMPT =
  "The forge restarted while you were answering and you are resuming this conversation. Before any write, read to see whether it already happened; a held write was answered once and is not to be asked again. Then finish your answer to the person's last message.";

/** Turns with a session listening, by conversation id: the run id a message is steered to. */
const live = new Map<string, string>();

/**
 * Where a turn runs: an empty directory of its own under the data dir, made at
 * first use, so nothing a turn could name sits beside forge.db or secret.key.
 */
export const turnDir = (dataDir: string): string => {
  const dir = join(dataDir, "conversation-cwd");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** The `--mcp-config` JSON: this forge's `/mcp`, the token read from the child's environment, never from its argv. */
export function mcpConfig(localUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER]: {
        type: "http",
        url: `${localUrl.replace(/\/+$/, "")}/mcp`,
        headers: { authorization: "Bearer ${FORGE_MCP_TOKEN}" },
      },
    },
  });
}

export type SayRefusal = "unauthorized" | "empty" | "too_long" | "no_account" | "resting" | "busy";

export interface Said {
  /** `started` a new turn, or `steered` one already running. */
  readonly how: "started" | "steered";
  /** Settles when the turn does; only a started turn has one. */
  readonly done?: Promise<void>;
}

/** Store a person's message and answer it: steer the turn that runs, or start one. */
export function say(app: App, options: ConversationOptions, userId: string, text: string): Result<Said, SayRefusal> {
  const user = getUserById(app.db, userId);
  if (user === undefined) return err("unauthorized");
  if (text.trim() === "") return err("empty");
  if (text.length > WORDS_MAX) return err("too_long");
  const conversation = openConversation(app.db, userId);
  const stored = appendTurn(app.db, userId, conversation.id, { role: "person", text });
  if (!stored.ok) return err("too_long");
  const running = live.get(conversation.id);
  if (running !== undefined && steerRun(app, running, text)) return ok({ how: "steered" });
  // A message nobody will answer is not kept: the door says why instead.
  const refuse = (why: SayRefusal): Result<Said, SayRefusal> => {
    removeTurn(app.db, userId, conversation.id, stored.value.id);
    return err(why);
  };
  if (live.size >= (options.liveMax ?? TURNS_LIVE_MAX)) return refuse("busy");
  const started = begin(app, options, conversation, text, 0, conversation.claudeSessionId || undefined);
  if (!started.ok) return refuse(started.error);
  return ok({ how: "started", done: started.value });
}

/**
 * Turns the last run of the forge left `running` are resumed once, from their
 * stored session, with one line to the person. A turn already resumed once
 * is closed as failed instead of looping on a restart that keeps coming.
 */
export function resumeInterrupted(app: App, options: ConversationOptions): Promise<void>[] {
  const rows = app.db
    .query<{ id: string; conversation_id: string; user_id: string; session_id: string; prompt: string; resumes: number }, []>(
      "SELECT id, conversation_id, user_id, session_id, prompt, resumes FROM conversation_run WHERE state = 'running' ORDER BY id",
    )
    .all();
  const done: Promise<void>[] = [];
  for (const row of rows) {
    // The cut turn's token is revoked now, resumed or not.
    app.db.query("DELETE FROM token WHERE id IN (SELECT token_id FROM via_token WHERE via = ?1)").run(`conversation:${row.conversation_id}`);
    app.db.query("UPDATE conversation_run SET state = 'failed', finished_at = ?2 WHERE id = ?1").run(row.id, new Date().toISOString());
    if (row.resumes >= 1) continue;
    const conversation = openConversation(app.db, row.user_id);
    if (conversation.id !== row.conversation_id) continue;
    appendTurn(app.db, row.user_id, conversation.id, { role: "agent", text: RESUMED_LINE });
    const session = conversation.claudeSessionId || row.session_id;
    const started = begin(app, options, conversation, row.prompt, row.resumes + 1, session === "" ? undefined : session);
    if (started.ok) done.push(started.value);
  }
  return done;
}

/**
 * The provider turned the turn away: the account rests and its window is
 * noted as a run's is (`takeLimit`). Returns the one line the person sees,
 * never the provider's words. The forge's own token cannot rest, so the next
 * message is accepted; the line says the window is full, not that anything rests.
 */
function limitLine(app: App, picked: Pick, message: string): string {
  const account = picked.kind === "ready" ? picked.subscription : undefined;
  const { until } = takeLimit(app.db, account?.id, message, "", new Date());
  return account === undefined
    ? `The forge's own model window is full until ${whenText(until)}; try again then.`
    : `${account.name} is resting until ${whenText(until)}.`;
}

function begin(
  app: App,
  options: ConversationOptions,
  conversation: Conversation,
  prompt: string,
  resumes: number,
  resumeSession: string | undefined,
): Result<Promise<void>, "no_account" | "resting" | "unauthorized"> {
  const userId = conversation.userId;
  const runId = id();
  const now = new Date();
  // The person's account, as any run's: a grant to them, else the forge's own for an admin.
  const picked = pickSubscription(app.db, app.config.dataDir, { repoId: "", ownerId: userId, agentId: "" }, now, {
    runId,
    usd: options.budgetUsd,
  });
  if (picked.kind === "none") return err("no_account");
  if (picked.kind === "resting") return err("resting");
  const left = dailyLeft(app.db, userId, now);
  const budget = Math.min(options.budgetUsd, picked.kind === "ready" ? (picked.capUsd ?? Infinity) : Infinity, left ?? Infinity);
  if (budget <= 0) return err("resting");
  const subscriptionId = picked.kind === "ready" ? picked.subscription.id : PLATFORM;
  // A new turn's token replaces the last one's.
  const via = `conversation:${conversation.id}`;
  app.db.query("DELETE FROM token WHERE id IN (SELECT token_id FROM via_token WHERE via = ?1)").run(via);
  const lifetime = Math.min(options.timeoutMs + 60_000, VIA_TOKEN_MAX_MS - 1000);
  const minted = mintViaToken(app.db, userId, via, prompt.slice(0, WORDS_MAX), new Date(now.getTime() + lifetime).toISOString());
  if (!minted.ok) return err("unauthorized");
  app.db
    .query(
      "INSERT INTO conversation_run (id, conversation_id, user_id, subscription_id, prompt, resumes, session_id, started_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
    )
    .run(runId, conversation.id, userId, subscriptionId, prompt, resumes, resumeSession ?? "", now.toISOString());
  live.set(conversation.id, runId);
  const put = (role: "agent" | "tool", text: string): void => {
    const stored = appendTurn(app.db, userId, conversation.id, { role, text: text.slice(0, 20_000) });
    if (stored.ok && role === "agent") streamed.push({ id: stored.value.id, text });
  };
  let lastText = "";
  // What the turn said as it went, by turn id, so a provider's refusal
  // printed as assistant text can be taken back.
  const streamed: { id: string; text: string }[] = [];
  // The policy only shapes a shell's sandbox; an MCP-only turn has no shell
  // and no file tools (`claudeSettings` with `mcp` omits it), so there is
  // nothing to enforce and an unenforced policy cannot fail the turn.
  const sandbox = sandboxPolicy({ dataDir: app.config.dataDir, agentName: "conversation", urls: [options.localUrl], enforced: false, runId });
  const turn = (async (): Promise<void> => {
    let outcome: ClaudeOutcome | undefined;
    let unlisten = (): void => {};
    try {
      const cwd = turnDir(app.config.dataDir);
      // A stored session made under another cwd cannot be resumed: Claude Code
      // then names no session at all. That one message starts fresh, once.
      for (let session = resumeSession; ; session = undefined) {
        let named = false;
        outcome = await runClaude({
          binary: options.binary,
          cwd,
          prompt: resumes > 0 && session !== undefined ? RESUME_PROMPT : prompt,
          appendSystemPrompt: CONVERSATION_BRIEF,
          model: options.model,
          budgetUsd: budget,
          resume: session,
          env: {
            ...credentialEnv(picked),
            ...(options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: options.configDir }),
            FORGE_MCP_TOKEN: minted.value.token,
          },
          sandbox,
          label: "conversation",
          timeoutMs: options.timeoutMs,
          log: (line) => appendRunLog(app.config.dataDir, runId, line),
          signal: options.signal,
          mcp: { config: mcpConfig(options.localUrl), allow: [`mcp__${MCP_SERVER}`] },
          onSteer: (send) => {
            unlisten = listenForSteer(runId, send);
          },
          onSession: (sessionId) => {
            named = true;
            app.db.query("UPDATE conversation_run SET session_id = ?2 WHERE id = ?1").run(runId, sessionId);
            setClaudeSession(app.db, userId, conversation.id, sessionId);
          },
          onSaid: (said) => {
            if (said.kind === "text") lastText = said.text;
            if (said.text.trim() !== "") put(said.kind === "text" ? "agent" : "tool", said.text);
          },
        });
        if (session === undefined || named || options.signal.aborted) break;
        appendRunLog(app.config.dataDir, runId, "no session to resume; starting this message fresh");
      }
    } catch (error) {
      app.log.warn("conversation turn failed", { error: String(error) });
    } finally {
      unlisten();
      if (live.get(conversation.id) === runId) live.delete(conversation.id);
    }
    const cost = outcome?.costUsd ?? 0;
    // Stopped for a restart: the row stays `running` for the next boot to
    // find, keeping what the session had reported (Claude Code names the
    // cost only in its result, so a cut turn keeps its tokens and the cost
    // it had). Its token is revoked at boot (`resumeInterrupted`).
    if (options.signal.aborted) {
      app.db.query("UPDATE conversation_run SET tokens_in = ?2, tokens_out = ?3, cost_usd = ?4 WHERE id = ?1").run(runId, outcome?.tokensIn ?? 0, outcome?.tokensOut ?? 0, cost);
      app.db.query("UPDATE subscription SET spent_usd = spent_usd + ?2 WHERE id = ?1").run(subscriptionId, cost);
      return;
    }
    app.db.query("DELETE FROM token WHERE id = ?1").run(minted.value.id);
    const answer = outcome?.result ?? "";
    if (outcome !== undefined && isRateLimited(outcome)) {
      // The provider's words are not shown: the streamed copy of them goes.
      const first = outcome.result.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
      for (const turn of streamed)
        if (turn.text === outcome.result || (first !== "" && turn.text.includes(first))) removeTurn(app.db, userId, conversation.id, turn.id);
      put("agent", limitLine(app, picked, outcome.result));
    }
    else if (answer.trim() !== "" && answer !== lastText) put("agent", answer);
    else if (answer.trim() === "" && lastText === "") put("agent", "I could not answer that just now.");
    app.db
      .query(
        "UPDATE conversation_run SET state = ?2, tokens_in = ?3, tokens_out = ?4, cost_usd = ?5, finished_at = ?6 WHERE id = ?1",
      )
      .run(runId, outcome?.ok ? "ok" : "failed", outcome?.tokensIn ?? 0, outcome?.tokensOut ?? 0, cost, new Date().toISOString());
    // Against the account's lifetime budget, like a run's cost (`subscription.spent_usd`).
    app.db.query("UPDATE subscription SET spent_usd = spent_usd + ?2 WHERE id = ?1").run(subscriptionId, cost);
  })();
  return ok(turn);
}
