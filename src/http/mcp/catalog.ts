/**
 * The tools a connection is offered up front, and how `find_tool` reaches the
 * rest. `tools/list` costs every session ~13k tokens in full, so the default
 * answer is this short list; any other tool stays callable by name, and
 * `find_tool` (or `tools/list` with `{"all": true}`) shows its schema.
 */
import type { Args } from "./shared.ts";

/**
 * The forge's control surface (#11957): direct the crew, see what happens,
 * manage apps and forges. Repo work is git's (clone and push), so the
 * file tools are not here; `find_tool` still reaches them. `report` and
 * `start` are open without a token, so they are always offered.
 */
export const DEFAULT_TOOLS: readonly string[] = [
  "tell", "say", "next_up", "now", "runs", "knobs",
  "usage", "apps", "app_deploy", "forges", "find_tool", "report", "start",
];

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** The longest query and the most words of it that matter. */
export const QUERY_MAX = 100;
export const WORDS_MAX = 8;

/** How many matches one answer holds. */
export const FIND_MAX = 8;

/** Entries matching every word of `query`, best first; a name weighs more than a description. */
export function matching(entries: readonly ToolEntry[], query: string): ToolEntry[] {
  const words = query
    .slice(0, QUERY_MAX)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w !== "")
    .slice(0, WORDS_MAX);
  if (words.length === 0) return [];
  const scored: { e: ToolEntry; score: number }[] = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    const desc = e.description.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const n = name.includes(w) ? (name === w ? 6 : 3) : 0;
      const d = desc.includes(w) ? 1 : 0;
      if (n + d === 0) all = false;
      score += n + d;
    }
    if (all) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name)).map((s) => s.e);
}

/** Whether `args.all` asks for today's full list. */
export const wantsAll = (params: Args): boolean => params["all"] === true;
