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
import { buildSystem, forAgent, type Roots, type SystemView } from "./view.ts";
import { during } from "../perf/jobs.ts";

const FRESH_MS = 1_000;

/** Readings of each core kept for the history on /system. */
export const HISTORY = 30;

/** How often a watched reading is pushed: only while someone is subscribed. */
export const PUSH_MS = 2_000;

export type Live = {
  read(now?: number): SystemView;
  /** Hear every sample pushed; the first subscriber starts the clock, the last stops it. */
  subscribe(listener: (view: SystemView) => void): () => void;
  /** Whether the push clock is running: only while someone is subscribed. */
  running(): boolean;
  /** Hand a sample to every subscriber (the clock does this; a test may too). */
  publish(view: SystemView): void;
};

/** Run `tick` every `ms` until the returned function is called; a test injects its own. */
export type Schedule = (tick: () => void, ms: number) => () => void;

const realSchedule: Schedule = (tick, ms) => {
  const t = setInterval(() => during("system-live", tick), ms);
  t.unref?.();
  return () => clearInterval(t);
};

export function createLive(options: { paths?: Paths; roots?: () => Roots; self?: number; pushMs?: number; schedule?: Schedule } = {}): Live {
  const paths = options.paths ?? HOST;
  const roots = options.roots ?? (() => cellRoots());
  const self = options.self ?? process.pid;
  let prev: Raw | undefined;
  let last: Raw | undefined;
  let view: SystemView | undefined;
  let history: number[][] = [];
  const listeners = new Set<(view: SystemView) => void>();
  const schedule = options.schedule ?? realSchedule;
  let timer: (() => void) | undefined;
  const handle: Live = {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === undefined) {
        timer = schedule(() => handle.publish(handle.read()), options.pushMs ?? PUSH_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          timer();
          timer = undefined;
        }
      };
    },
    running: () => timer !== undefined,
    publish(sample) {
      for (const listener of [...listeners]) {
        try {
          listener(sample);
        } catch {
          // one broken viewer never starves the others
        }
      }
    },
    read(now = Date.now()) {
      if (view !== undefined && last !== undefined && now - last.at < FRESH_MS) return view;
      const raw = readRaw(paths, now);
      // A first reading has no rate: its rates are null until a second reading is taken.
      prev = last;
      last = raw;
      const built = buildSystem(prev, last, roots(), self);
      history = built.cpu.cores.map((c, i) => [...(history[i] ?? []), c ?? 0].slice(-HISTORY));
      view = { ...built, cpu: { ...built.cpu, history } };
      return view;
    },
  };
  return handle;
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
