/**
 * The latest reading of the machine, shared by every viewer. There is no
 * timer: a reading is taken when someone asks and the last one is more
 * than a second old, and the rates are over the two most recent. A viewer
 * that polls every 2 s therefore *is* the 2 s sampler, and costs nothing
 * when nobody looks. The node's own history is `boards/sampler.ts`'s.
 */
import type { App } from "../app.ts";
import { cellRoots } from "../apps/contain.ts";
import { HOST, readRaw, type Paths, type Raw } from "./proc.ts";
import { buildSystem, forAgent, type SystemView } from "./view.ts";

const FRESH_MS = 1_000;

export type Live = {
  read(now?: number): SystemView;
};

export function createLive(options: { paths?: Paths; roots?: typeof cellRoots; self?: number } = {}): Live {
  const paths = options.paths ?? HOST;
  const roots = options.roots ?? cellRoots;
  const self = options.self ?? process.pid;
  let prev: Raw | undefined;
  let last: Raw | undefined;
  let view: SystemView | undefined;
  return {
    read(now = Date.now()) {
      if (view !== undefined && last !== undefined && now - last.at < FRESH_MS) return view;
      const raw = readRaw(paths, now);
      // A first reading has no rate: its rates are null until a second reading is taken.
      prev = last;
      last = raw;
      view = buildSystem(prev, last, roots(), self);
      return view;
    },
  };
}

let shared = createLive();
export const live = (): Live => shared;
/** Swap the shared reading — a test hands it a /proc it wrote. */
export const useLive = (next: Live): void => {
  shared = next;
};

/** Whether the repository behind a cell's label is public. An unknown label is not. */
export function publicLabel(app: App, label: string): boolean {
  const check = /^check:([\w-]{1,64})$/.exec(label);
  const cell = /^app:([\w.-]{1,64})\//.exec(label);
  const row = check
    ? app.db
        .query<{ v: string }, [string]>(
          "SELECT repo.visibility AS v FROM run JOIN repo ON repo.id = run.repo_id WHERE run.id = ?1",
        )
        .get(check[1]!)
    : cell
      ? app.db
          .query<{ v: string }, [string]>(
            "SELECT repo.visibility AS v FROM app JOIN repo ON repo.id = app.repo_id WHERE app.slug = ?1",
          )
          .get(cell[1]!)
      : undefined;
  return row?.v === "public";
}

/** The view a named agent may read. */
export const agentView = (app: App, view: SystemView): SystemView =>
  forAgent(view, (label) => publicLabel(app, label));
