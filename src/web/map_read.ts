/**
 * The map's answer, built from a database handle and plain data: the one
 * reading both the serving thread (a test, a forge with no file) and the map
 * worker (`map_worker.ts`) make. Nothing here touches a request or a socket.
 */

import type { App } from "../app.ts";
import { repoGraph } from "../core/dependencies.ts";
import { pillarView } from "../core/pillars.ts";
import { askToLiveOf } from "../core/pillars.ts";
import { getRepoById } from "../core/repos.ts";
import { listActiveRuns } from "../core/runs.ts";
import { mapHeldFor } from "../crew/held.ts";
import { rememberPullFiles } from "../crew/hot_files.ts";
import { mapJson, marksFor } from "./pages/map.ts";

/** What a reading is asked: plain data only, so it crosses to a worker whole. */
export interface MapJob {
  readonly repoId: string;
  readonly scope: { readonly sealed?: true; readonly sealedBy?: string };
}

/** The map's JSON and what each step cost, in order. */
export interface MapReading {
  readonly value: Record<string, unknown>;
  readonly phases: readonly (readonly [string, number])[];
}

/** `learned` is the serving thread's memory of which files each open pull touches: the held step reads it. */
export type Learned = readonly { repoId: string; number: number; files: readonly string[] }[];

export function readMap(app: App, job: MapJob, learned: Learned = []): MapReading | undefined {
  const repo = getRepoById(app.db, job.repoId);
  if (repo === undefined) return undefined;
  if (learned.length > 0) {
    const byRepo = new Map<string, { number: number; files: readonly string[] }[]>();
    for (const p of learned) byRepo.set(p.repoId, [...(byRepo.get(p.repoId) ?? []), { number: p.number, files: p.files }]);
    for (const [repoId, pulls] of byRepo) rememberPullFiles(repoId, pulls);
  }
  const scope = { ...job.scope };
  const phases: [string, number][] = [];
  const timed = <T>(name: string, work: () => T): T => {
    const t = performance.now();
    const value = work();
    phases.push([name, performance.now() - t]);
    return value;
  };
  const graph = timed("graph", () => repoGraph(app.db, repo.id, { ...scope }));
  const marks = timed("marks", () => marksFor(app.db, repo.id, graph, listActiveRuns(app.db, [repo.id])));
  const pillars = timed("pillars", () => pillarView(app.db, repo));
  const ask = timed("asktolive", () => (pillars === undefined ? [] : askToLiveOf(app.db, repo, pillars, scope)));
  const held = timed("held", () => mapHeldFor(app, repo, graph, scope));
  const value = timed("render", () => mapJson(repo, graph, marks, pillars, ask, held));
  return { value, phases };
}
