/** Append text to a run's log file, making the runs directory first. Shared by the log's writer thread and its fallback. */

import { appendFileSync, mkdirSync } from "node:fs";

const made = new Set<string>();

export function appendTo(root: string, path: string, text: string): void {
  if (!made.has(root)) {
    mkdirSync(root, { recursive: true });
    made.add(root);
  }
  try {
    appendFileSync(path, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // The directory was removed under us: make it again, once.
    mkdirSync(root, { recursive: true });
    appendFileSync(path, text);
  }
}
