/**
 * A check's steps as one cluster Job (`checks.placement: job`): install and
 * check run in order in the Job's container, over the checks root the claim
 * holds. The Job's log is written into the run's log and its node recorded;
 * the answer has `runStep`'s shape, so the caller is the same for both.
 */
import { JobVanished, runJob, type JobOptions, type JobSpec } from "../cluster/jobs.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { Placement } from "./placement.ts";

/** What a NetworkPolicy selects a check's pod by (docs/APPS.md, Placement). */
export const JOB_LABELS = { "forge-check": "true" };

/** The error a vanished Job answers with; the service queues the run again. */
export const JOB_VANISHED = "the cluster job vanished";

export async function runJobStep(
  placement: Extract<Placement, { mode: "job" }>,
  input: {
    runId: string;
    dir: string;
    commands: string[];
    env: Record<string, string>;
    log: (line: string) => void;
    signal: AbortSignal;
    timeoutMs: number;
    limits: { memoryMiB: number; cpus: number; diskMiB: number };
    /** The Job's own output, apart from the echoed commands. */
    output: string[];
    onNode: (node: string) => void;
    options?: JobOptions;
  },
): Promise<Result<void, string>> {
  // Only the check's own variables cross to the cluster, never the forge's.
  const env = Object.fromEntries(Object.entries(input.env).filter(([k]) => k === "CI" || k.startsWith("FORGE_")));
  const spec: JobSpec = {
    name: `check-${input.runId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(0, 53).replace(/-+$/, ""),
    image: placement.image,
    command: ["/bin/sh", "-c", input.commands.join(" && ")],
    env,
    nodeSelector: placement.nodeSelector,
    tolerations: placement.tolerations,
    // Only this run's own checkout, never the root the claim holds.
    volume: { claim: placement.claim, mountPath: input.dir, subPath: input.runId },
    limits: input.limits,
    labels: JOB_LABELS,
  };
  for (const c of input.commands) input.log(`$ ${c}`);
  let result;
  try {
    result = await runJob(spec, { timeoutMs: input.timeoutMs, signal: input.signal, ...input.options });
  } catch (error) {
    if (input.signal.aborted) return err("check cancelled");
    if (error instanceof JobVanished) {
      input.log(`${JOB_VANISHED}: ${error.message}`);
      return err(JOB_VANISHED);
    }
    return err(`job could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.node) input.onNode(result.node);
  for (const line of result.lines) {
    input.output.push(line);
    input.log(line);
  }
  if (result.timedOut) return err(`check took longer than ${Math.round(input.timeoutMs / 1000)}s`);
  if (result.exitCode === 0) return ok();
  return err(`check exited with code ${result.exitCode ?? "unknown"}`);
}
