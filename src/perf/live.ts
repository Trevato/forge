/** The process's one record, git record (#8158) and loop watch (#7559): what the server feeds and the duty reads. */

import { createBootStall } from "./boot_stall.ts";
import { createGitRecord } from "./git.ts";
import { jobWatch } from "./jobs.ts";
import { createLoopWatch } from "./loop.ts";
import { createInFlight } from "./in_flight.ts";
import { patternOf } from "../http/usage_tag.ts";
import { createCaptureStore } from "./capture.ts";
import { createReadLedger } from "./reads.ts";
import { createStallBlame } from "./stall_blame.ts";
import { createPerfRecord } from "./record.ts";
import { createLagMinutes } from "./lag_minutes.ts";

export const perfRecord = createPerfRecord();
/** The requests the server is answering now (#11478): begun and ended around each one in `http/server.ts`. */
export const inFlight = createInFlight<Request>(patternOf);
/**
 * A stall names the requests that ran across it, finished or still in flight
 * (#11478); when none did, the background jobs that did (#10834).
 */
export const loopWatch = createLoopWatch(undefined, jobWatch.across, inFlight.since);
export const gitRecord = createGitRecord();
/** The worst stall in this process's first five minutes, read by the release keeper (#8848). */
export const bootStall = createBootStall();
/** What was read from repositories (`reads.ts`), and the one bounded capture an admin may run (`capture.ts`). */
export const readLedger = createReadLedger();
export const captureStore = createCaptureStore();
/** Each stall over 200 ms with what ran (#11069): the last hour's worst on /system, the last 10 s's on `/healthz`. */
export const stallBlame = createStallBlame();
/**
 * The last 20 minutes' worst loop lag (#11220), each blamed on the worst stall
 * `stallBlame` named in it: /system and the MCP `system` tool read it.
 */
export const lagMinutes = createLagMinutes((to, span) => stallBlame.worst(to, span, 1)[0]?.what ?? null);
