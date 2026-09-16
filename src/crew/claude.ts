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

import { childEnv, pump } from "../apps/process.ts";
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
  readonly timeoutMs: number;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
}

export interface ClaudeOutcome {
  /** Whether the run ended with a result rather than an error. */
  readonly ok: boolean;
  readonly sessionId: string;
  /** The agent's final message. */
  readonly result: string;
  readonly costUsd: number;
  readonly turns: number;
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
): Record<string, unknown> {
  return {
    sandbox: {
      enabled: sandbox.enforced,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: [...sandbox.allowHosts],
        // An app under test listens on a local port.
        allowLocalBinding: true,
      },
      filesystem: { denyRead: [...sandbox.denyRead] },
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
    "--restricted",
    // Restricted mode drops every tool that runs code unless it is named
    // here; "default" does not name Bash. This is the agent's whole kit.
    "--tools",
    TOOLS.join(","),
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify(claudeSettings(input.sandbox)),
    "--max-budget-usd",
    input.budgetUsd.toFixed(2),
    "--append-system-prompt",
    input.appendSystemPrompt,
  ];
  if (input.model !== undefined && input.model !== "")
    args.push("--model", input.model);
  if (input.resume !== undefined && input.resume !== "")
    args.push("--resume", input.resume);
  return args;
}

/** Run Claude Code to completion. Never throws; every ending is an outcome. */
export async function runClaude(input: ClaudeInput): Promise<ClaudeOutcome> {
  const proc = Bun.spawn([input.binary, ...claudeArgs(input)], {
    cwd: input.cwd,
    env: childEnv({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      ...input.env,
    }),
    stdin: new Blob([input.prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });

  let sessionId = "";
  let result = "";
  let costUsd = 0;
  let turns = 0;
  let reason = "";
  let ok = false;
  let sawResult = false;

  const onLine = (line: string): void => {
    if (line.trim() === "") return;
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
    if (typeof e["session_id"] === "string" && sessionId === "")
      sessionId = e["session_id"];
    if (type === "system") {
      if (e["subtype"] === "init")
        input.log(`session ${sessionId} (${String(e["model"] ?? "")})`);
      return;
    }
    if (type === "assistant") {
      for (const text of assistantLines(e)) input.log(text);
      return;
    }
    if (type === "result") {
      sawResult = true;
      ok = e["is_error"] !== true && e["subtype"] === "success";
      result = typeof e["result"] === "string" ? e["result"] : "";
      costUsd =
        typeof e["total_cost_usd"] === "number" ? e["total_cost_usd"] : 0;
      turns = typeof e["num_turns"] === "number" ? e["num_turns"] : 0;
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
      return;
    }
    // `user` records are tool results: long and mostly file contents.
  };

  let why: "timeout" | "cancelled" | undefined;
  const stopChild = (): void => {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null)
        proc.kill("SIGKILL");
    }, 5_000);
  };
  const timer = setTimeout(() => {
    why = "timeout";
    stopChild();
  }, input.timeoutMs);
  const onAbort = (): void => {
    why = "cancelled";
    stopChild();
  };
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });

  const stderr: string[] = [];
  const [, , code] = await Promise.all([
    pump(proc.stdout, onLine),
    pump(proc.stderr, (line) => {
      stderr.push(line);
      if (stderr.length > 50) stderr.shift();
      input.log(`! ${line}`);
    }),
    proc.exited,
  ]);
  clearTimeout(timer);
  input.signal.removeEventListener("abort", onAbort);

  if (why !== undefined) {
    return { ok: false, sessionId, result, costUsd, turns, reason: why };
  }
  if (!sawResult) {
    const tail = stderr.slice(-3).join(" | ");
    return {
      ok: false,
      sessionId,
      result: tail,
      costUsd,
      turns,
      reason: `exit ${code}`,
    };
  }
  return { ok, sessionId, result, costUsd, turns, reason };
}

/** The lines a person wants from an assistant turn: its words and its tool calls. */
function assistantLines(e: Record<string, unknown>): string[] {
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
        `→ ${describeTool(String(block["name"] ?? "tool"), block["input"])}`,
      );
    }
  }
  return out;
}

function describeTool(name: string, input: unknown): string {
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
  const detail = first([
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "description",
    "prompt",
  ]);
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
      stderr: "pipe",
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
