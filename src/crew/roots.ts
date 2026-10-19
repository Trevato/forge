/**
 * The crew runs in flight, as labelled roots for `/system`: Claude Code is
 * the root of its tree (it makes its own bubblewrap), so the process table
 * groups what it spawned under `crew:<name>`. There is no cap: a root is
 * dropped when its process exits, so the map is as large as the runs in flight,
 * which the runner already bounds.
 */
const live = new Map<symbol, { label: string; root: number }>();

/** Name `pid` as the root of `label` until the returned function is called. */
export function watchCrewRoot(label: string, pid: number): () => void {
  const key = Symbol(label);
  live.set(key, { label, root: pid });
  return () => void live.delete(key);
}

export function crewRoots(): { label: string; root: number }[] {
  return [...live.values()];
}
