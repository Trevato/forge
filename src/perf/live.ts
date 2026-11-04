/** The process's one record, git record (#8158) and loop watch (#7559): what the server feeds and the duty reads. */

import { createBootStall } from "./boot_stall.ts";
import { createGitRecord } from "./git.ts";
import { createLoopWatch } from "./loop.ts";
import { createPerfRecord } from "./record.ts";

export const perfRecord = createPerfRecord();
export const loopWatch = createLoopWatch();
export const gitRecord = createGitRecord();
/** The worst stall in this process's first five minutes, read by the release keeper (#8848). */
export const bootStall = createBootStall();
