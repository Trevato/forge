/**
 * A repository's AGENTS.md, for the route (`http/agents_md.ts`) and the
 * terminal (`tui/screens/agents_md.ts`): its own root file when it has one,
 * else the generated text. One reader, so both say the same words. The caller
 * has already checked the person may read the repository.
 */

import type { Repo } from "../core/repos.ts";
import { blobForRender } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { generatedAgentsMd } from "../web/doors_words.ts";

export const OWN_MAX = 200_000;

export interface AgentsMd {
  readonly text: string;
  /** `own`: the repository's file; `generated`: the forge's text. */
  readonly source: "own" | "generated";
}

export async function agentsMdOf(reposRoot: string, repo: Repo, origin: string): Promise<AgentsMd> {
  const dir = repoDir(reposRoot, repo.ownerName, repo.name);
  let tooLarge = false;
  try {
    const blob = await blobForRender(dir, repo.defaultBranch, "AGENTS.md", OWN_MAX);
    if (blob.kind === "text") return { text: new TextDecoder().decode(blob.body), source: "own" };
    tooLarge = blob.kind === "too_large";
  } catch {
    // An empty repository or an unreadable ref has no file: the generated text answers.
  }
  const generated = generatedAgentsMd(origin, repo.ownerName, repo.name, repo.defaultBranch);
  const note = tooLarge ? `\nNote: this repository's own AGENTS.md is over ${OWN_MAX / 1000} KB and is not served here; read it in the repository.\n` : "";
  return { text: generated + note, source: "generated" };
}
