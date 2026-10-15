/** The release knobs from the environment, validated; what is malformed is left unset. */

export function releaseEnv(env: Record<string, string | undefined>): {
  forgeRepo?: string;
  releasesKeep?: number;
} {
  const repo = env.FORGE_REPO ?? "";
  const keep = Number(env.FORGE_RELEASES_KEEP);
  return {
    ...(/^[\w.-]+\/[\w.-]+$/.test(repo) ? { forgeRepo: repo } : {}),
    ...(Number.isInteger(keep) && keep >= 1 ? { releasesKeep: keep } : {}),
  };
}
