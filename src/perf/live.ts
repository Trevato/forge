/** The process's one record and loop watch (#7559): what the server feeds and the duty reads. */

import { createLoopWatch } from "./loop.ts";
import { createPerfRecord } from "./record.ts";

export const perfRecord = createPerfRecord();
export const loopWatch = createLoopWatch();
