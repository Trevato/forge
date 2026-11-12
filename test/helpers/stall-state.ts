/**
 * The process's stall watch, starting clean and left clean (#11069). The
 * suite runs every file in one process, and `loopWatch`, `stallBlame` and the
 * telemetry reader counts (`perf/live.ts`, `system/telemetry_reads.ts`) are
 * that process's; a stall one file noted would otherwise be a row in the next
 * file's /system. Call at a file's top level, as `quietLogs` is
 * (`globals.ts`): it clears before the file's first test and after its last.
 */

import { afterAll, beforeAll } from "bun:test";
import { loopWatch, stallBlame } from "../../src/perf/live.ts";
import { resetTelemetryReads } from "../../src/system/telemetry_reads.ts";

/** Forget every stall and telemetry read the process has noted. */
export function clearStallState(): void {
  loopWatch.clear();
  stallBlame.clear();
  resetTelemetryReads();
}

/** Clear the process's stall watch before this scope runs and after it. */
export function freshStallState(): void {
  beforeAll(clearStallState);
  afterAll(clearStallState);
}
