/**
 * The writer side of `log.ts`: append each batch of lines to its files, then
 * count the batch done where the forge's thread can wait for it (a reader of
 * a log, and exit, need every line on disk; the timer's flush does not wait).
 */

import { appendTo } from "./log_append.ts";

/** What the writer is given: a batch number, the shared counter, and `[runs root, file, text]` per file. */
export interface LogBatch {
  readonly n: number;
  readonly done: SharedArrayBuffer;
  readonly items: readonly (readonly [string, string, string])[];
}

declare const self: Worker;

self.onmessage = (e: MessageEvent<LogBatch>) => {
  for (const [root, path, text] of e.data.items) {
    try {
      appendTo(root, path, text);
    } catch {
      // A full disk loses the lines it could not take; the run goes on.
    }
  }
  const done = new Int32Array(e.data.done);
  Atomics.store(done, 0, e.data.n);
  Atomics.notify(done, 0);
};
