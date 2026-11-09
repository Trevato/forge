/**
 * Crew teams' words (#2681): the sentences a person reads about the teams an
 * issue names. One place, so the web merge box, the terminal and the API/MCP
 * say the same thing when a team holds a pull (#9930). Plain text: names are
 * escaped where they are rendered, not here. Nothing renders these yet.
 */

/** "Waiting on Design's review", or "…on Design's and Data science's reviews"; "" with no teams. */
export function waitingOnTeams(names: readonly string[]): string {
  const owned = names.map((n) => `${n.trim()}'s`);
  if (owned.length === 0) return "";
  if (owned.length === 1) return `Waiting on ${owned[0]} review`;
  const list = `${owned.slice(0, -1).join(", ")} and ${owned[owned.length - 1]}`;
  return `Waiting on ${list} reviews`;
}
