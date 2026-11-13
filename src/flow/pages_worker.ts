/**
 * The worker side of `/boards` and `/flow` (`pages.ts`): read a page's
 * picture on a read-only handle of its own, so the forge's one thread never
 * walks the pulls and the ready lists, and never starts a git process, to
 * draw either page. The same pattern as `lanes_worker.ts`: the thread posts a
 * job and receives the answer.
 */

import { Database } from "bun:sqlite";
import type { ForgeConfig } from "../app.ts";
import { readPagePicture, type BoardsPicture, type FlowPicture, type PageJob, type PagesEnv } from "./pages_read.ts";

/** What the worker is asked. */
export interface PagesAsk {
  readonly id: number;
  readonly path: string;
  readonly reposRoot: string;
  readonly config: ForgeConfig;
  readonly ceilingUsd: number | null;
  readonly job: PageJob;
  readonly learned: readonly { repoId: string; number: number; files: readonly string[] }[];
}

/** What it answers: the picture, or why it could not. */
export interface PagesAnswer {
  readonly id: number;
  readonly picture?: BoardsPicture | FlowPicture;
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
