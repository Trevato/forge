/**
 * The worker side of the map (`map_snapshot.ts`): build the answer on a
 * read-only handle of its own, so the forge's one thread never walks the
 * graph, the runs and the deploys to draw it. The same pattern as
 * `lanes_worker.ts` and `pages_worker.ts`: the thread posts a job of plain
 * data and receives the answer.
 */

// The first import is the order two modules that read each other need (`breaker` and `guard`): this worker starts from the map, not from `main`.
import "../crew/breaker.ts";
import { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { PagesConfig } from "../flow/pages_read.ts";
import { readMap, type Learned, type MapJob, type MapReading } from "./map_read.ts";

/** What the worker is asked: plain data (never the app's config, which holds objects with methods). */
export interface MapAsk {
  readonly id: number;
  readonly path: string;
  readonly reposRoot: string;
  readonly config: PagesConfig;
  readonly job: MapJob;
  readonly learned: Learned;
}

/** What it answers: the reading, `missing` for a repository that is gone, or why it could not. */
export interface MapAnswer {
  readonly id: number;
  readonly reading?: MapReading;
  readonly missing?: true;
  readonly error?: string;
}

declare const self: Worker;

/** The app the readers that take one are given: its database, its repositories and its settings, nothing that serves. */
const apps = new Map<string, App>();

self.onmessage = (e: MessageEvent<MapAsk>) => {
  const { id, path, reposRoot, config, job, learned } = e.data;
  try {
    let app = apps.get(path);
    if (app === undefined) {
      const db = new Database(path, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      apps.set(path, (app = { db, reposRoot, config } as unknown as App));
    }
    const reading = readMap(app, job, learned);
    postMessage((reading === undefined ? { id, missing: true } : { id, reading }) satisfies MapAnswer);
  } catch (error) {
    postMessage({ id, error: String(error) } satisfies MapAnswer);
  }
};
