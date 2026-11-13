/**
 * The serving thread's side of the engine Worker: start it, keep it, wake the
 * tail when it says it appended, and start it again when it dies.
 *
 * A dead engine is not a dead forge. Its transaction is rolled back with its
 * handle (SQLite releases the lock when the connection closes, and a Worker's
 * ends with it), the serving thread goes on answering, and the new engine
 * takes up the duties from their own rows: every duty is a sweep or a
 * compare-and-set, which is what lets two forges share a data directory for
 * a roll (docs/ARCHITECTURE.md, "Two processes at once").
 */

import type { ForgeConfig } from "../app.ts";
import type { EventTail } from "../core/event_tail.ts";
import { createLog } from "../kernel/log.ts";
import { during } from "../perf/jobs.ts";
import { BEAT_MS, STALL_MS } from "./beat.ts";
import type { EngineInit } from "./worker.ts";

const log = createLog("engine");

/** The first wait before a dead engine is started again; it doubles to `RESTART_MAX_MS`. */
export const RESTART_MIN_MS = 500;
export const RESTART_MAX_MS = 30_000;
/** An engine that ran this long is forgiven its earlier deaths. */
const STABLE_MS = 60_000;

export interface Engine {
  /** Resolves when the current engine said it is ready. */
  ready(): Promise<void>;
  /** How many times an engine has been started after a death. */
  restarts(): number;
  /** Stop the duties, then the thread. */
  stop(): Promise<void>;
  /** For tests: end the thread now, as a crash would; the engine starts again. */
  kill(): void;
}

function environment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}

export function startEngine(
  config: ForgeConfig,
  tail: Pick<EventTail, "poke">,
  options: { extra?: readonly string[]; restartMinMs?: number; stallMs?: number } = {},
): Engine {
  let worker: Worker | undefined;
  let stopping = false;
  let restarts = 0;
  let deaths = 0;
  let readyAt: Promise<void> = Promise.resolve();
  let resolveReady: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plain = Object.fromEntries(Object.entries(config).filter(([, v]) => typeof v !== "function"));

  const launch = (): void => {
    const started = Date.now();
    readyAt = new Promise<void>((resolve) => (resolveReady = resolve));
    // The environment as it is now: a Worker is otherwise given the one the process started with.
    const w = new Worker(new URL("./worker.ts", import.meta.url).href, { env: environment() });
    worker = w;
    let beat = Date.now();
    w.onmessage = (event: MessageEvent<string>) => {
      beat = Date.now();
      if (event.data === "a") tail.poke();
      else if (event.data === "ready") {
        log.info("the engine is up", { restarts });
        resolveReady();
      }
    };
    let ended = false;
    const died = (why: string): void => {
      if (ended || stopping) return;
      ended = true;
      clearInterval(watch);
      if (worker === w) worker = undefined;
      deaths = Date.now() - started > STABLE_MS ? 1 : deaths + 1;
      const wait = Math.min(RESTART_MAX_MS, (options.restartMinMs ?? RESTART_MIN_MS) * 2 ** (deaths - 1));
      log.error("the engine stopped; serving goes on, it starts again", { why, inMs: wait, restarts: restarts + 1 });
      timer = setTimeout(
        () =>
          during("engine-restart", () => {
            restarts++;
            launch();
          }),
        wait,
      );
    };
    // A thread stuck holding a write would hold every write of the serving thread with it.
    const watch = setInterval(() => {
      during("engine-watch", () => {
        if (stopping) return clearInterval(watch);
        if (Date.now() - beat <= (options.stallMs ?? STALL_MS)) return;
        clearInterval(watch);
        w.terminate();
        died("silent");
      });
    }, BEAT_MS);
    watch.unref();
    w.onerror = (event: ErrorEvent) => died(String(event.message ?? event));
    w.addEventListener("close", () => died("closed"));
    const init: EngineInit = { op: "init", config: plain as unknown as ForgeConfig, ...(options.extra ? { extra: options.extra } : {}) };
    w.postMessage(init);
  };
  launch();

  return {
    ready: () => readyAt,
    restarts: () => restarts,
    kill: () => worker?.terminate(),
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      const w = worker;
      worker = undefined;
      if (w === undefined) return;
      // Told to stop, it says so; one that does not say so in ten seconds is ended all the same.
      const said = new Promise<void>((resolve) =>
        w.addEventListener("message", (e: MessageEvent<string>) => e.data === "stopped" && resolve()),
      );
      w.postMessage("stop");
      await Promise.race([said, Bun.sleep(10_000)]);
      w.terminate();
    },
  };
}
