/**
 * What a refused steer says (#7598): one sentence per code `steerRepoRun`
 * returns, so the run page's steer box and MCP `steer` word it the same.
 */
import { SAY_SOMETHING_WORDS } from "./tell_words.ts";
import { VERIFY_FIRST } from "./verify_words.ts";

const REFUSED: Readonly<Record<string, string>> = {
  empty: SAY_SOMETHING_WORDS,
  not_agent: "Only an agent's run can be steered.",
  not_found: "There is no such run here.",
  unauthorized: "Sign in to steer a run.",
  unverified: `${VERIFY_FIRST[0]!.toUpperCase()}${VERIFY_FIRST.slice(1)} to steer a run.`,
  forbidden: "You need write access to steer a run.",
};

/** The sentence for a refused steer; an unknown code reads as no access. */
export function steerRefusedWords(code: string): string {
  return REFUSED[code] ?? REFUSED["forbidden"]!;
}
