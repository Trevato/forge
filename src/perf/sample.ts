/**
 * A stall sampled on the live forge (#8103). `sampleStacks` runs JavaScriptCore's
 * sampling profiler for a few seconds and folds what it saw into the stacks
 * that were on the CPU most, so an admin can ask a running forge "what is
 * the main thread doing" with no tools on the host. One sample at a time.
 */

import * as jsc from "bun:jsc";

export const MAX_SECONDS = 30;
export const DEFAULT_SECONDS = 10;
const TOP = 40;

interface Frame { name?: string; sourceURL?: string; line?: number }
interface Profile { interval: number; traces: { frames: Frame[] }[] }
const profiler = jsc as unknown as {
  startSamplingProfiler(): void;
  samplingProfilerStackTraces(): Profile;
};

export interface Sampled {
  readonly seconds: number;
  readonly samples: number;
  readonly note: string;
  readonly stacks: { count: number; stack: string }[];
}

/** One frame on one line: `name (file:line)`, the file cut to its last two parts. */
export function frameLine(f: Frame): string {
  const file = (f.sourceURL ?? "").split("/").slice(-2).join("/");
  const line = f.line !== undefined && f.line < 1_000_000 ? `:${f.line}` : "";
  return `${f.name || "(anonymous)"} (${file}${line})`;
}

/** The profile's traces counted by their top `depth` frames, most frequent first. */
export function foldStacks(profile: Pick<Profile, "traces">, depth = 8): Sampled["stacks"] {
  const counts = new Map<string, number>();
  for (const t of profile.traces) {
    const stack = t.frames.slice(0, depth).map(frameLine).join(" < ");
    counts.set(stack, (counts.get(stack) ?? 0) + 1);
  }
  return [...counts]
    .map(([stack, count]) => ({ count, stack }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP);
}

const NOTE = "the profiler stays attached until this process restarts; a wait on another process's database lock may fail early meanwhile";

let sampling = false;

/** Sample for `seconds` (1 to 30), or undefined while another sample runs. */
export async function sampleStacks(seconds: number = DEFAULT_SECONDS): Promise<Sampled | undefined> {
  if (sampling) return undefined;
  sampling = true;
  try {
    const secs = Math.min(MAX_SECONDS, Math.max(1, Math.floor(seconds)));
    profiler.startSamplingProfiler();
    profiler.samplingProfilerStackTraces(); // drop what ran before this window
    await new Promise((r) => setTimeout(r, secs * 1000));
    const profile = profiler.samplingProfilerStackTraces();
    return { seconds: secs, samples: profile.traces.length, note: NOTE, stacks: foldStacks(profile) };
  } finally {
    sampling = false;
  }
}
