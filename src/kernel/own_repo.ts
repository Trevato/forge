/** The repository this forge fixes itself in: `FORGE_SENTINEL_REPO`, else `trevato/forge`. */
export const ownRepoPath = (): string => (process.env.FORGE_SENTINEL_REPO ?? "trevato/forge").trim();
