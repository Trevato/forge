/**
 * The process a data query runs in (`query.ts`): one job as JSON on stdin, one answer as JSON on stdout.
 * It sets SQLite's heap limit, which is the whole process's, so it can only be set here and never in the forge.
 */
import { runJob, type Job } from "./query_worker.ts";

const job = JSON.parse(await Bun.stdin.text()) as Job;
process.stdout.write(JSON.stringify(runJob(job)));
