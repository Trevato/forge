/**
 * The consistent copy of the database, made off the serving thread. `VACUUM
 * INTO` held the main thread 8.8 s on 2026-11-02 (#8742): every page, every
 * request, frozen for as long as the copy took. A worker opens the same file
 * on its own connection and copies it there; WAL gives it a consistent read
 * while the forge keeps writing. An in-memory database has no file for
 * another connection to open, and is copied in place (tests only).
 */

import type { Database } from "bun:sqlite";
import type { VacuumJob } from "./vacuum_worker.ts";

export async function vacuumInto(db: Database, to: string): Promise<void> {
  const from = db.filename;
  if (from === "" || from === ":memory:") {
    db.run("VACUUM INTO ?1", [to]);
    return;
  }
  await vacuumFile(from, to);
}

/** The same for a database file nobody holds open here. */
export async function vacuumFile(from: string, to: string): Promise<void> {
  const worker = new Worker(new URL("./vacuum_worker.ts", import.meta.url).href);
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ error?: string }>) =>
        e.data.error === undefined ? resolve() : reject(new Error(e.data.error));
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ from, to } satisfies VacuumJob);
    });
  } finally {
    worker.terminate();
  }
}
