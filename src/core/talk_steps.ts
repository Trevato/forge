/**
 * One tool call as a short readable step (#11009): "Read src/a.ts", "Edited
 * src/app.ts (+12)", "Opened pull #12". Plain data in, plain data out: the
 * stored call is `<tool> <json args>` (`crew/conversation.ts`); the label
 * is built from the tool name and a few validated args, never from raw JSON,
 * and the details are `key: value` lines, each value cut short. A call that
 * cannot be read still gets a label from its tool name. `repoOf` names the
 * repository a run of turns last worked on, for the preview beside the chat.
 */

import type { Said } from "./talk_work.ts";

export interface Step {
  /** The one line shown while the step is closed. */
  readonly label: string;
  /** `key: value` lines shown when it opens; never JSON. */
  readonly details: readonly string[];
}

const PREFIX = /^mcp__[a-z0-9-]+__/;
const TOOL = /^[a-z0-9_]{1,60}$/;
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const VALUE_MAX = 160;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const cut = (s: string): string => (s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s);
const words = (tool: string): string => {
  const w = tool.replaceAll("_", " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** The tool and arguments of a stored call turn, or undefined when it is not one. */
export function parseCall(text: string): { tool: string; args: Record<string, unknown> } | undefined {
  if (text.startsWith("{")) return undefined;
  const space = text.indexOf(" ");
  const tool = (space < 0 ? text : text.slice(0, space)).replace(PREFIX, "");
  if (!TOOL.test(tool)) return undefined;
  try {
    const args: unknown = space < 0 ? {} : JSON.parse(text.slice(space + 1));
    return { tool, args: typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
  } catch {
    return { tool, args: {} };
  }
}

/** Lines in a string: what a write added. */
const lines = (s: string): number => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

/** The step a call stands for. */
export function stepOf(text: string): Step | undefined {
  const call = parseCall(text);
  if (call === undefined) return undefined;
  const { tool, args } = call;
  const path = cut(str(args["path"]));
  const n = typeof args["number"] === "number" && Number.isInteger(args["number"]) && args["number"] > 0 ? args["number"] : undefined;
  const details = Object.entries(args)
    .slice(0, 8)
    .map(([k, v]) => `${k.slice(0, 40)}: ${cut(typeof v === "string" ? v : JSON.stringify(v) ?? "")}`);
  let label = words(tool);
  if (tool === "read_file") label = path === "" ? "Read a file" : `Read ${path}`;
  else if (tool === "write_file") {
    const content = args["content"];
    label = `${path === "" ? "Edited a file" : `Edited ${path}`}${typeof content === "string" ? ` (+${String(lines(content))})` : ""}`;
  } else if (tool === "issue" && n !== undefined) label = `Opened issue #${String(n)}`;
  else if (tool === "pull" && n !== undefined) label = `Opened pull #${String(n)}`;
  else if (tool === "merge" && n !== undefined) label = args["dryRun"] === true ? `Checked that pull #${String(n)} can merge` : `Merged pull #${String(n)} and deployed`;
  else if (tool === "review" && n !== undefined) label = `Reviewed pull #${String(n)}`;
  else if (tool === "say" && n !== undefined) label = `Commented on #${String(n)}`;
  else if (tool === "keep_plan" && n !== undefined) label = `Updated the plan on #${String(n)}`;
  return { label: cut(label), details };
}

/** The repository the last call that named a good one worked on. */
export function repoOf(turns: readonly Said[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.role !== "tool") continue;
    const repo = parseCall(t.text)?.args["repo"];
    if (typeof repo === "string" && REPO.test(repo)) return repo;
  }
  return undefined;
}

const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\n]{1,300}$/;

/** The files the calls on `repo` read or edited, newest first, each once, at most `max`. */
export function filesOf(turns: readonly Said[], repo: string, max = 12): string[] {
  const seen = new Set<string>();
  for (let i = turns.length - 1; i >= 0 && seen.size < max; i -= 1) {
    const t = turns[i]!;
    if (t.role !== "tool") continue;
    const call = parseCall(t.text);
    if (call === undefined || (call.tool !== "read_file" && call.tool !== "write_file") || call.args["repo"] !== repo) continue;
    const path = call.args["path"];
    if (typeof path === "string" && PATH.test(path)) seen.add(path);
  }
  return [...seen];
}
