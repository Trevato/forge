/**
 * The engine's thread (`FORGE_ENGINE=worker`). It opens the forge's database
 * on a handle of its own, starts the duties (`duties.ts`) and talks to the
 * serving thread in one-byte messages: it says it appended (`"a"`, after the
 * transaction that appended has ended). Everything else crosses in the
 * database: the outbox is the one bus (`core/event_tail.ts`), and this thread
 * reacts to nothing on it yet, so it does not tail.
 */

import { createApp, type ForgeConfig } from "../app.ts";
import { loadFlags } from "../core/flags.ts";
import { startDuties } from "./duties.ts";
import { timeStatements } from "../kernel/slow_sql.ts";
import { createLog } from "../kernel/log.ts";
import { during } from "../perf/jobs.ts";
import { BEAT_MS } from "./beat.ts";

declare const self: Worker;

export interface EngineInit {
  readonly op: "init";
  readonly config: ForgeConfig;
  /** Test seam: modules whose default export `(app) => stop` runs beside the duties. */
  readonly extra?: readonly string[];
}

let stop: (() => void) | undefined;

self.onmessage = (event: MessageEvent<EngineInit | "stop">) => {
  const m = event.data;
  if (m === "stop") {
    stop?.();
    stop = undefined;
    postMessage("stopped");
  } else if (m.op === "init") void boot(m);
};

async function boot(init: EngineInit): Promise<void> {
  // Mostly writes and small reads: a smaller cache than the serving thread's (`kernel/db.ts`).
  process.env["FORGE_DB_CACHE_MIB"] ??= "128";
  const app = createApp({ ...init.config, seedSignup: false });
  timeStatements(app.db, createLog("sql"));
  loadFlags(app.db);
  // The serving thread hears what this one appends from the outbox; this tells it to look now.
  let told = false;
  app.bus.afterAppend = () => {
    if (told) return;
    told = true;
    // After the transaction that appended: it is synchronous, so by a microtask it has ended.
    queueMicrotask(() => {
      told = false;
      postMessage("a");
    });
  };
  const stops = [startDuties(app, { onWorker: true })];
  for (const path of init.extra ?? []) {
    const made = (await import(path)) as { default: (app: unknown) => () => void };
    stops.push(made.default(app));
  }
  stop = () => {
    for (const s of stops) s();
    app.close();
  };
  // Alive: a thread stuck in one statement stops saying so, and the serving thread ends it (`host.ts`).
  const beat = setInterval(() => during("engine-beat", () => postMessage("h")), BEAT_MS);
  const was = stop;
  stop = () => {
    clearInterval(beat);
    was?.();
  };
  postMessage("ready");
}
