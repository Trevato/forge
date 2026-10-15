/** The release knobs from the environment, validated; what is malformed is left unset. */

export function releaseEnv(env: Record<string, string | undefined>): {
  forgeRepo?: string;
  releasesKeep?: number;
  selfSwap?: boolean;
  swapBudgetMs?: number;
} {
  const repo = env.FORGE_REPO ?? "";
  const budget = Number(env.FORGE_SWAP_BUDGET_S);
  const keep = Number(env.FORGE_RELEASES_KEEP);
  return {
    ...(/^[\w.-]+\/[\w.-]+$/.test(repo) ? { forgeRepo: repo } : {}),
    ...(env.FORGE_SELF_SWAP === "1" ? { selfSwap: true } : {}),
    ...(Number.isInteger(budget) && budget >= 1 && budget <= 600 ? { swapBudgetMs: budget * 1000 } : {}),
    ...(Number.isInteger(keep) && keep >= 1 ? { releasesKeep: keep } : {}),
  };
}
