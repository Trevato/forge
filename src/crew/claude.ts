/**
 * Claude Code, headless, as a child process — the way the forge runs git.
 * `claude -p` with stream-json output gives one JSON object per line: an
 * init record with the session id, the assistant's turns, the tool results,
 * and a final result with the cost and why it stopped. This module builds
 * the invocation, streams the transcript into a log in words a person
 * reads, and returns the outcome.
 *
 * Containment is the forge's, not the agent's: file tools confined to the
 * clone (`--restricted`), permissions handed in as settings, no prompts
 * (anything that would ask is denied), no MCP servers the operator has, no
 * settings files of the operator's, a spend budget, and a deadline.
 */

import { measureOf, type Measure } from "../core/measure.ts";
import { backgroundArgv, crewCpus } from "../apps/background.ts";
import { cgroupHost } from "../apps/cgroup.ts";
import { openRunCell, type RunLimits } from "./run-cell.ts";
import { watchLabelled } from "../apps/contain.ts";
import { childEnv, pump } from "../apps/process.ts";
import { endedLine, liveTree } from "../runs/ended.ts";
import { CANCEL_GRACE_MS } from "../runs/grace.ts";
import { spellings, stripForgeDirs } from "../runs/paths.ts";
import type { SandboxPolicy } from "./sandbox.ts";

export interface ClaudeInput {
  readonly binary: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly model?: string | undefined;
  readonly budgetUsd: number;
  /** A session id to continue. */
  readonly resume?: string | undefined;
  readonly env: Record<string, string>;
  readonly sandbox: SandboxPolicy;
  /** The run's machine's memory and CPU ceilings (`crew/run-cell.ts`); none is today's cell. */
  readonly limits?: RunLimits | undefined;
  /** What `/system` calls this run's process tree (`crew:<name>`); unlabelled when absent. */
  readonly label?: string | undefined;
  readonly timeoutMs: number;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
  /** Images that go with the prompt, once: base64 data and its media type (#8820). */
  readonly images?: readonly { readonly mediaType: string; readonly data: string }[] | undefined;
  /**
   * Hands the caller a way to say something to the agent while it runs.
   * The words arrive as its next user turn, after the step it is on; a
   * send after the session ended returns false.
   */
  readonly onSteer?: ((send: (text: string) => boolean) => void) | undefined;
  /**
   * The session's spend so far, each time it reports some: tokens as each
   * assistant message's `usage` arrives, the cost once the result names it
   * (Claude Code reports `total_cost_usd` only at the end). Running totals
   * for this invocation, never deltas.
   */
  readonly onUsage?: ((spent: Spent) => void) | undefined;
  /** The provider's measurement of a window, each time the session reports one (#8960). */
  readonly onMeasure?: ((measure: Measure) => void) | undefined;
  /**
   * Talks to the forge through MCP alone (#7651): no file or shell tools, no
   * clone, the one server named in `config` (`--mcp-config` JSON) allowed.
   */
  readonly mcp?: { readonly config: string; readonly allow: readonly string[] } | undefined;
  /** The session id, once the init record names it (a restart resumes it). */
  readonly onSession?: ((sessionId: string) => void) | undefined;
  /** What the agent said or called, as each assistant message arrives. */
  readonly onSaid?: ((said: { readonly kind: "text" | "tool" | "thinking"; readonly text: string }) => void) | undefined;
  /**
   * How long a session may stay silent after a result while its input is
   * still open (a steer was pending) before it is closed and settled as
   * done. A steer folded into the turn it interrupted leaves a result owed
   * that never comes. Default `IDLE_AFTER_RESULT_MS`.
   */
  readonly idleMs?: number | undefined;
  /**
   * How long the process has to exit once its input is closed after the
   * final result. Past it the process group is stopped and the run settles
   * on the result it already gave. Default `SETTLE_MS`.
   */
  readonly settleMs?: number | undefined;
}

/** The idle guard's default: five minutes of silence after a result. */
export const IDLE_AFTER_RESULT_MS = 5 * 60_000;
/** The grace a finished session has to exit on its own. */
export const SETTLE_MS = 5_000;

export interface Spent {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface ClaudeOutcome {
  /** Whether the run ended with a result rather than an error. */
  readonly ok: boolean;
  readonly sessionId: string;
  /** The agent's final message. */
  readonly result: string;
  readonly costUsd: number;
  readonly turns: number;
  /**
   * Tokens the model read (fresh input, cache writes and cache reads) and
   * wrote, from the result's `usage`; 0 when the run reported none.
   */
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** What the last assistant message read: the session's context at its end; 0 when none reported. */
  readonly contextTokens: number;
  /** The model's context window in tokens, from the result's `modelUsage`; 0 when it named none. */
  readonly contextWindow: number;
  /** `completed`, `max_budget_reached`, `timeout`, `cancelled`, `error`, `exit <n>`. */
  readonly reason: string;
}

/** The run spent its budget and Claude Code stopped it. */
export const BUDGET_REACHED = "max_budget_reached";

/**
 * The tools an agent has. Enough to read, change, run and push code; no
 * subagents (a run is one agent), no web (the task is in the clone and the
 * forge's API), nothing that asks a person.
 */
export const TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/**
 * The settings handed to every run. One object, so the policy is one place:
 * the tools, the commands refused outright, and the sandbox around the
 * shell (`crew/sandbox.ts` says what it may reach and read).
 */
export function claudeSettings(
  sandbox: SandboxPolicy,
  mcp?: ClaudeInput["mcp"],
): Record<string, unknown> {
  if (mcp !== undefined)
    return { permissions: { allow: [...mcp.allow], deny: [...TOOLS] } };
  return {
    sandbox: {
      enabled: sandbox.enforced,
      autoAllowBashIfSandboxed: true,
      // The sandbox is the boundary, not a suggestion: no command runs
      // outside it on request, and a host that was going to enforce it
      // fails the run rather than running the shell open.
      allowUnsandboxedCommands: false,
      failIfUnavailable: sandbox.enforced,
      network: {
        allowedDomains: [...sandbox.allowHosts],
        // An app under test listens on a local port.
        allowLocalBinding: true,
      },
      filesystem: {
        denyRead: [...sandbox.denyRead],
        ...(sandbox.readAllow.length === 0
          ? {}
          : { allowRead: [...sandbox.readAllow] }),
        ...(sandbox.installCache === undefined
          ? {}
          : { allowWrite: [sandbox.installCache] }),
      },
    },
    permissions: {
      allow: [...TOOLS],
      deny: [
        "Bash(git push --force*)",
        "Bash(git push -f*)",
        "Bash(git push * --force*)",
        "Bash(sudo *)",
        "Bash(rm -rf /*)",
        "Bash(rm -rf ~*)",
      ],
    },
  };
}

export function claudeArgs(input: ClaudeInput): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    // The prompt comes over stdin as a user message, and so can anything
    // a person says while the run goes: the session stays open until the
    // forge closes it.
    "--input-format",
    "stream-json",
    "--restricted",
    // Restricted mode drops every tool that runs code unless it is named
    // here; "default" does not name Bash. This is the agent's whole kit.
    "--tools",
    input.mcp === undefined ? TOOLS.join(",") : "",
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify(claudeSettings(input.sandbox, input.mcp)),
    "--max-budget-usd",
    input.budgetUsd.toFixed(2),
    "--append-system-prompt",
    input.appendSystemPrompt,
  ];
  if (input.mcp !== undefined) args.push("--mcp-config", input.mcp.config);
  if (input.model !== undefined && input.model !== "")
    args.push("--model", input.model);
  if (input.resume !== undefined && input.resume !== "")
    args.push("--resume", input.resume);
  return args;
}

/** Run Claude Code to completion. Never throws; every ending is an outcome. */
export async function runClaude(input: ClaudeInput): Promise<ClaudeOutcome> {
  // Background work, with everything its shell starts: the forge's own
  // pages outrank it (#3319, `apps/background.ts`). A binary that is not
  // there is spawned bare, so it fails as itself (ENOENT, caught by the
  // caller as a failed run) and not as `nice`'s exit 127. Where the forge
  // holds a cgroup, the run gets a cell of its own, weighed and held to
  // `FORGE_CREW_CPUS` cores, so it no longer shares the forge's leaf; its
  // machine may narrow that cell with a memory cap and fewer cores.
  const argv = [input.binary, ...claudeArgs(input)];
  const present = Bun.which(input.binary) !== null;
  const cell = present ? openRunCell(input.limits ?? {}, cgroupHost(), crewCpus(), input.log) : undefined;
  const cgroup = cell?.cgroup;
  const contained = cell === undefined ? argv : cell.wrap(argv);
  const spawn = (): ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> =>
    Bun.spawn(present ? backgroundArgv(contained) : argv, {
    cwd: input.cwd,
    env: childEnv({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      ...input.env,
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Its own session, so a cancel can reach whatever it spawned in turn
    // (a tool call left running) and not just the agent itself: a signal
    // to one pid never touches a grandchild holding stdout open.
    detached: true,
  });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (error) {
    cgroup?.remove();
    throw error;
  }
  // The cell goes with the run, and whatever it left running with it.
  if (cgroup !== undefined) void proc.exited.finally(() => cgroup.remove());
  if (input.label !== undefined) {
    const unwatch = watchLabelled(proc.pid, input.label);
    void proc.exited.finally(unwatch);
  }
  // What the agent hears: the prompt first, then whatever a person says
  // while it works. Each is a user turn; the session ends when the forge
  // closes its stdin after a turn nobody followed.
  let pending = 0;
  let open = true;
  const say = (text: string, images: ClaudeInput["images"] = []): boolean => {
    if (!open || proc.exitCode !== null || proc.signalCode !== null)
      return false;
    try {
      proc.stdin.write(
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
              { type: "text", text },
            ],
          },
        })}\n`,
      );
      proc.stdin.flush();
      return true;
    } catch {
      return false;
    }
  };
  const closeInput = (): void => {
    if (!open) return;
    open = false;
    try {
      proc.stdin.end();
    } catch {
      // already gone
    }
  };
  say(input.prompt, input.images);
  input.onSteer?.((text) => {
    if (!say(text)) return false;
    pending++;
    return true;
  });

  let sessionId = "";
  let result = "";
  let costUsd = 0;
  let turns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let contextTokens = 0;
  let contextWindow = 0;
  let reason = "";
  let ok = false;
  let sawResult = false;
  // A message's usage repeats on every content block of it, growing; the
  // last word per message id is the message's spend.
  const perMessage = new Map<string, { tokensIn: number; tokensOut: number }>();

  // The reads end on their own when the process exits — unless something it
  // spawned still holds the pipe. Aborting them is how a settled session
  // stops waiting on a server the agent left running.
  const stopReading = new AbortController();
  const idleMs = input.idleMs ?? IDLE_AFTER_RESULT_MS;
  const settleMs = input.settleMs ?? SETTLE_MS;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  // After a result with a steer pending, the session owes another turn; any
  // line it writes is that turn going. Silence past `idleMs` means it is not.
  const armIdle = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      input.log(
        `session: no output for ${Math.round(idleMs / 1000)}s after its last result; closing it`,
      );
      finish();
    }, idleMs);
  };
  // The work is over: close the input and give the process `settleMs` to
  // go. One that lingers is stopped, and the result it gave stands.
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(idle);
    closeInput();
    settle = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        input.log(
          `session: still open ${Math.round(settleMs / 1000)}s after its result; stopping it`,
        );
        stopChild();
      }
      stopReading.abort();
    }, settleMs);
  };

  // The workdir as the forge named it and as the agent's process reports
  // it: a tool line reads `CREW.md` under either spelling.
  const workdir = spellings([input.cwd]);
  const onLine = (line: string): void => {
    if (line.trim() === "") return;
    if (sawResult && !finished) armIdle();
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      input.log(line);
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const e = event as Record<string, unknown>;
    const type = e["type"];
    if (typeof e["session_id"] === "string" && sessionId === "") {
      sessionId = e["session_id"];
      input.onSession?.(sessionId);
    }
    if (type === "rate_limit_event") {
      const measure = measureOf(e, new Date());
      if (measure !== undefined) input.onMeasure?.(measure);
      return;
    }
    if (type === "system") {
      if (e["subtype"] === "init")
        input.log(`session ${sessionId} (${String(e["model"] ?? "")})`);
      return;
    }
    if (type === "assistant") {
      for (const text of assistantLines(e, workdir)) input.log(text);
      const message = e["message"];
      if (input.onSaid && typeof message === "object" && message !== null) {
        const content = (message as Record<string, unknown>)["content"];
        for (const block of Array.isArray(content) ? content : []) {
          const b = (block ?? {}) as Record<string, unknown>;
          if (b["type"] === "text" && typeof b["text"] === "string")
            input.onSaid({ kind: "text", text: b["text"] });
          else if (b["type"] === "thinking" && typeof b["thinking"] === "string")
            input.onSaid({ kind: "thinking", text: b["thinking"] });
          else if (b["type"] === "tool_use" && typeof b["name"] === "string")
            input.onSaid({ kind: "tool", text: `${b["name"]} ${JSON.stringify(b["input"] ?? {})}` });
        }
      }
      if (typeof message === "object" && message !== null) {
        const m = message as Record<string, unknown>;
        if (typeof m["usage"] === "object" && m["usage"] !== null) {
          const key =
            typeof m["id"] === "string" ? m["id"] : `#${perMessage.size}`;
          const used = tokensOf(m["usage"]);
          // What the last message read is the context the session holds.
          contextTokens = used.tokensIn;
          perMessage.set(key, used);
          if (input.onUsage) {
            let tokensIn = 0;
            let tokensOut = 0;
            for (const t of perMessage.values()) {
              tokensIn += t.tokensIn;
              tokensOut += t.tokensOut;
            }
            input.onUsage({ tokensIn, tokensOut, costUsd: 0 });
          }
        }
      }
      return;
    }
    if (type === "result") {
      sawResult = true;
      ok = e["is_error"] !== true && e["subtype"] === "success";
      result = typeof e["result"] === "string" ? e["result"] : "";
      costUsd =
        typeof e["total_cost_usd"] === "number" ? e["total_cost_usd"] : 0;
      contextWindow = windowOf(e["modelUsage"]);
      turns = typeof e["num_turns"] === "number" ? e["num_turns"] : 0;
      ({ tokensIn, tokensOut } = tokensOf(e["usage"]));
      input.onUsage?.({ tokensIn, tokensOut, costUsd });
      const terminal = e["terminal_reason"];
      // Claude Code names the budget ending twice (`error_max_budget_usd`
      // as the subtype, `budget_exhausted` as the terminal reason); the
      // forge keeps one word, so the runner and the summary do not follow
      // a rename.
      const budget =
        e["subtype"] === "error_max_budget_usd" ||
        terminal === "budget_exhausted";
      reason = budget
        ? BUDGET_REACHED
        : typeof terminal === "string"
          ? terminal
          : ok
            ? "completed"
            : String(e["subtype"] ?? "error");
      if (!ok && result === "") {
        const errors = e["errors"];
        if (Array.isArray(errors)) result = errors.map(String).join("; ");
      }
      // A turn is over. Something said meanwhile is the next turn; nothing
      // said means the session is done, and closing stdin lets it end.
      if (pending > 0 && ok) {
        pending--;
        armIdle();
      } else finish();
      return;
    }
    // `user` records are tool results: long and mostly file contents.
  };

  // Signals the whole process group (a negative pid), so anything the
  // agent spawned in turn goes with it; falls back to the process alone
  // if the group is already gone.
  const signalGroup = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      proc.kill(sig);
    }
  };
  let why: "timeout" | "cancelled" | undefined;
  const stopChild = (): void => {
    closeInput();
    signalGroup("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null)
        signalGroup("SIGKILL");
      stopReading.abort();
    }, CANCEL_GRACE_MS).unref();
  };
  const timer = setTimeout(() => {
    why = "timeout";
    stopChild();
  }, input.timeoutMs);
  const onAbort = (): void => {
    why = "cancelled";
    input.log(endedLine(liveTree(proc.pid).length));
    stopChild();
  };
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });

  const stderr: string[] = [];
  const [, , code] = await Promise.all([
    pump(proc.stdout, onLine, stopReading.signal),
    pump(
      proc.stderr,
      (line) => {
        stderr.push(line);
        if (stderr.length > 50) stderr.shift();
        input.log(`! ${line}`);
      },
      stopReading.signal,
    ),
    proc.exited,
  ]);
  // However the session ended, whatever is left in its group goes with it:
  // Claude Code's sandbox bridges (`socat UNIX-LISTEN:…,fork`, one per
  // proxy, plus a fork per connection) outlive a session that did not stop
  // them, and 255 of them were alive in one pod (#3708).
  reapGroup(proc.pid);
  clearTimeout(timer);
  clearTimeout(idle);
  clearTimeout(settle);
  closeInput();
  input.signal.removeEventListener("abort", onAbort);

  if (why !== undefined) {
    return {
      ok: false,
      sessionId,
      result,
      costUsd,
      turns,
      tokensIn,
      tokensOut,
      contextTokens,
      contextWindow,
      reason: why,
    };
  }
  if (!sawResult) {
    const tail = stderr.slice(-3).join(" | ");
    return {
      ok: false,
      sessionId,
      result: tail,
      costUsd,
      turns,
      tokensIn,
      tokensOut,
      contextTokens,
      contextWindow,
      reason: `exit ${code}`,
    };
  }
  return { ok, sessionId, result, costUsd, turns, tokensIn, tokensOut, contextTokens, contextWindow, reason };
}

/**
 * SIGKILL every process still in the group `pgid` leads. Called once its
 * leader (a session started `detached`, so its own group) has exited:
 * anything left is a leftover. Linux keeps a pid from reuse while a group
 * still carries it, so this never reaches a stranger; an empty group is
 * ESRCH and nothing happens.
 */
export function reapGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // the group is empty: nothing was left behind
  }
}

/** The largest `contextWindow` a result's `modelUsage` names, 0 when none. */
export function windowOf(modelUsage: unknown): number {
  if (typeof modelUsage !== "object" || modelUsage === null) return 0;
  let most = 0;
  for (const v of Object.values(modelUsage)) {
    const w = typeof v === "object" && v !== null ? (v as Record<string, unknown>)["contextWindow"] : undefined;
    if (typeof w === "number" && Number.isFinite(w) && w > most) most = Math.floor(w);
  }
  return most;
}

/**
 * The token counts of a result's `usage` object. Input is every token the
 * model read: `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens`; output is `output_tokens`. A missing or odd
 * field counts 0, never NaN.
 */
export function tokensOf(usage: unknown): {
  tokensIn: number;
  tokensOut: number;
} {
  if (typeof usage !== "object" || usage === null)
    return { tokensIn: 0, tokensOut: 0 };
  const u = usage as Record<string, unknown>;
  const n = (key: string): number => {
    const v = u[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0
      ? Math.round(v)
      : 0;
  };
  return {
    tokensIn:
      n("input_tokens") +
      n("cache_creation_input_tokens") +
      n("cache_read_input_tokens"),
    tokensOut: n("output_tokens"),
  };
}

/** The lines a person wants from an assistant turn: its words and its tool calls. */
function assistantLines(
  e: Record<string, unknown>,
  workdir: readonly string[],
): string[] {
  const message = e["message"];
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      for (const line of block["text"].split("\n"))
        if (line.trim() !== "") out.push(line);
    } else if (block["type"] === "tool_use") {
      out.push(
        `→ ${describeTool(String(block["name"] ?? "tool"), block["input"], workdir)}`,
      );
    }
  }
  return out;
}

function describeTool(
  name: string,
  input: unknown,
  workdir: readonly string[],
): string {
  const args =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const first = (keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return "";
  };
  const detail = stripForgeDirs(
    workdir,
    first([
      "command",
      "file_path",
      "path",
      "pattern",
      "url",
      "description",
      "prompt",
    ]),
  );
  const short = detail.length > 160 ? `${detail.slice(0, 157)}…` : detail;
  return short === "" ? name : `${name} ${short}`;
}

/** Whether `binary` is a Claude Code that speaks this interface. */
export async function detectClaude(
  binary: string,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const proc = Bun.spawn([binary, "--version"], {
      env: childEnv({}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0)
      return { ok: false, error: `${binary} --version exited ${code}` };
    const version = out.trim().split(/\s+/)[0] ?? "";
    const [major, minor] = version.split(".").map(Number);
    if (
      major === undefined ||
      minor === undefined ||
      major < 2 ||
      (major === 2 && minor < 1)
    )
      return {
        ok: false,
        error: `${binary} is ${version}; 2.1 or later is needed`,
      };
    return { ok: true, version };
  } catch (error) {
    return {
      ok: false,
      error: `${binary}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
