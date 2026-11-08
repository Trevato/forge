/** The worker side of `vacuum.ts`: copy `from` into `to` and say so. */

import { Database } from "bun:sqlite";

/** What the worker is asked: the file to read and the copy to make. */
export interface VacuumJob {
  readonly from: string;
  readonly to: string;
}

declare const self: Worker;

self.onmessage = (e: MessageEvent<VacuumJob>) => {
  try {
    const db = new Database(e.data.from, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 30000");
      db.run("VACUUM INTO ?1", [e.data.to]);
    } finally {
      db.close();
    }
    postMessage({});
  } catch (error) {
    postMessage({ error: String(error) });
  }
};
