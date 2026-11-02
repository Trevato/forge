/** The process's one record, git record (#8158) and loop watch (#7559): what the server feeds and the duty reads. */

import { createGitRecord } from "./git.ts";
import { createLoopWatch } from "./loop.ts";
import { createPerfRecord } from "./record.ts";

export const perfRecord = createPerfRecord();
export const loopWatch = createLoopWatch();
export const gitRecord = createGitRecord();
