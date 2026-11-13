/**
 * The worker side of `/boards`, `/flow`, a board and the data page
 * (`pages.ts`): read a page's picture on a read-only handle of its own, so
 * the forge's one thread never walks the pulls, the ready lists, the events
 * or the samples, and never starts a git process, to draw one. The same pattern as `lanes_worker.ts`: the thread posts a
 * job and receives the answer.
 */

import { Database } from "bun:sqlite";
import { readPagePicture, type PageJob, type PagesConfig, type PagesEnv, type Picture } from "./pages_read.ts";

/** What the worker is asked. */
export interface PagesAsk {
  readonly id: number;
  readonly path: string;
  readonly reposRoot: string;
  readonly config: PagesConfig;
  readonly ceilingUsd: number | null;
  readonly job: PageJob;
  readonly learned: readonly { repoId: string; number: number; files: readonly string[] }[];
}

/** What it answers: the picture, or why it could not. */
export interface PagesAnswer {
  readonly id: number;
  readonly picture?: Picture;
  readonly error?: string;
}

declare const self: Worker;

const envs = new Map<string, PagesEnv>();

self.onmessage = (e: MessageEvent<PagesAsk>) => {
  const { id, path, reposRoot, config, ceilingUsd, job, learned } = e.data;
  let env = envs.get(path);
  try {
    if (env === undefined) {
      const db = new Database(path, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      envs.set(path, (env = { db, reposRoot, config, ceilingUsd, inline: false }));
    }
  } catch (error) {
    postMessage({ id, error: String(error) } satisfies PagesAnswer);
    return;
  }
  readPagePicture(env, job, learned).then(
    (picture) => postMessage({ id, picture } satisfies PagesAnswer),
    (error) => postMessage({ id, error: String(error) } satisfies PagesAnswer),
  );
};
