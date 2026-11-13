/**
 * What the engine thread does in the split's tests, beside its duties: the
 * `ENGINE_TEST` environment says which. A test seam (`engine/worker.ts`, `extra`).
 *
 *  - `writer`: short write transactions, back to back (or `ENGINE_TEST_EVERY_MS` apart), each with one outbox event.
 *  - `claimer`: takes every queued run it can, by the compare-and-set the crew uses.
 *  - `hang`: writes, and while a second transaction is open and half done, never returns.
 */

import type { App } from "../../src/app.ts";
import { claimRun } from "../../src/core/runs.ts";
import { transact } from "../../src/kernel/db.ts";

export default function start(app: App): () => void {
  const mode = process.env["ENGINE_TEST"] ?? "writer";
  const repoId = process.env["ENGINE_TEST_REPO"] ?? null;
  app.db.exec("CREATE TABLE IF NOT EXISTS engine_scratch (id INTEGER PRIMARY KEY, n INTEGER, life INTEGER)");
  let stopped = false;
  const life = (app.db.query<{ n: number }, []>("SELECT COUNT(DISTINCT life) AS n FROM engine_scratch WHERE life > 0").get()?.n ?? 0) + 1;
  let n = 0;
  const pause = Number(process.env["ENGINE_TEST_EVERY_MS"] ?? 0);
  const writer = (): void => {
    if (stopped) return;
    transact(app.db, () => {
      for (let i = 0; i < 5; i++) app.db.query("INSERT INTO engine_scratch (n, life) VALUES (?1, ?2)").run(++n, life);
      app.bus.append({ kind: process.env["ENGINE_TEST_KIND"] ?? "engine.probe", ...(repoId === null ? {} : { repoId }), payload: { n, life, number: 0, label: "probe" } });
    });
    // Flat out, or pausing `ENGINE_TEST_EVERY_MS` between transactions (a duty cycle, not a loop).
    if (pause > 0) setTimeout(writer, pause);
    else setImmediate(writer);
  };
  if (mode === "claimer") {
    const sweep = (): void => {
      if (stopped) return;
      for (const row of app.db.query<{ id: string }, []>("SELECT id FROM run WHERE state = 'queued' LIMIT 200").all()) {
        if (claimRun(app.db, row.id) !== undefined)
          app.db.query("INSERT INTO engine_scratch (n, life) VALUES (?1, ?2)").run(-1, life);
      }
      setImmediate(sweep);
    };
    sweep();
  } else if (mode === "hang" && life === 1) {
    transact(app.db, () => app.db.query("INSERT INTO engine_scratch (n, life) VALUES (0, 1)").run());
    // The second transaction: half done, and the thread stays inside it.
    app.db.exec("BEGIN IMMEDIATE");
    app.db.query("INSERT INTO engine_scratch (n, life) VALUES (-99, 1)").run();
    app.bus.append({ kind: "engine.half", payload: { n: -99 } });
    for (;;) {
      /* a statement that never ends */
    }
  } else if (mode !== "idle") writer();
  return () => {
    stopped = true;
  };
}
