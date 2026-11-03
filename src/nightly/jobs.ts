/**
 * The nightly jobs and what each runs: the two that used to be Forgejo
 * workflows (`flake-hunt.yml`, `outside-gate.yml`), now the forge's own.
 * The third, `sync-env.yml`, has nothing to run (docs/features/nightly.md).
 * Each step is a shell command run in a cell on a checkout of the default
 * branch; `reports` says it talks to the forge's API as the hunt's author,
 * so it is the only kind handed the token. Plain data.
 */

import type { Slot } from "./slots.ts";

export interface Step {
  readonly label: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly reports: boolean;
}

export interface Job {
  readonly name: "outside-gate" | "flake-hunt";
  readonly slot: Slot;
  readonly steps: readonly Step[];
  /** After the steps: the file whose quarantined edit is proposed as a pull. */
  readonly proposes?: { readonly path: string; readonly branchPrefix: string };
}

/** The gate is cut into this many slices, each hunted on its own. */
export const HUNT_SLICES = 20;
const SLICE_MS = 30 * 60_000;

const install: Step = {
  label: "install",
  command: "bun install --frozen-lockfile",
  timeoutMs: 10 * 60_000,
  reports: false,
};

/** Exit 1 is "found a flake and filed it": the quarantine's work, not a broken hunt. */
const huntSlice = (n: number): Step => ({
  label: `hunt slice ${n}/${HUNT_SLICES}`,
  command: `bun scripts/flake-hunt.ts hunt --shard ${n}/${HUNT_SLICES} --file-issues; code=$?; test "$code" -le 1`,
  timeoutMs: SLICE_MS,
  reports: true,
});

export const JOBS: readonly Job[] = [
  {
    name: "flake-hunt",
    slot: { hour: 2, minute: 17 },
    steps: [
      install,
      ...Array.from({ length: HUNT_SLICES }, (_, i) => huntSlice(i + 1)),
      {
        label: "quarantine",
        command: "bun scripts/flake-hunt.ts quarantine",
        timeoutMs: 10 * 60_000,
        reports: true,
      },
    ],
    proposes: { path: "scripts/gate.ts", branchPrefix: "flake-hunt" },
  },
  {
    name: "outside-gate",
    slot: { hour: 3, minute: 47 },
    steps: [
      install,
      {
        label: "run the excluded files",
        command: "bun scripts/flake-hunt.ts outside --file-issues",
        timeoutMs: SLICE_MS,
        reports: true,
      },
    ],
  },
];
