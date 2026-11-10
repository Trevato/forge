/** The process's one record, git record (#8158) and loop watch (#7559): what the server feeds and the duty reads. */

import { createBootStall } from "./boot_stall.ts";
import { createGitRecord } from "./git.ts";
import { jobWatch } from "./jobs.ts";
import { createLoopWatch } from "./loop.ts";
import { createCaptureStore } from "./capture.ts";
import { createReadLedger } from "./reads.ts";
import { createPerfRecord } from "./record.ts";

export const perfRecord = createPerfRecord();
/** A stall no request ran across names the background jobs that did (#10834). */
export const loopWatch = createLoopWatch(undefined, jobWatch.across);
export const gitRecord = createGitRecord();
/** The worst stall in this process's first five minutes, read by the release keeper (#8848). */
export const bootStall = createBootStall();
/** What was read from repositories (`reads.ts`), and the one bounded capture an admin may run (`capture.ts`). */
export const readLedger = createReadLedger();
export const captureStore = createCaptureStore();
