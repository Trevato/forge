/** What the efficiency watcher measures (#7558): each cost by cause, its unit, its floor and ceiling, and the code path that starts it. Plain data. */

export interface Cause {
  /** Lowercase words and dashes; the sample's `cause`. */
  readonly id: string;
  readonly label: string;
  /** "bytes", "seconds" or "ratio" (0 to 1): the unit every number of this cause is in, hourly. */
  readonly unit: "bytes" | "seconds" | "ratio";
  /** "rising" is bad when it doubles; "falling" (a hit rate) is bad when it halves. */
  readonly direction: "rising" | "falling";
  /**
   * Rising: an hour below this is never "doubled" (a baseline of nothing makes any byte a doubling).
   * Falling: a baseline below this is never "fallen from" (a cache that rarely hit has nothing to lose).
   */
  readonly floor: number;
  /** An hour at or above this files at once, baseline or not. */
  readonly ceiling: number | undefined;
  /** Where the cost starts, named in the finding. */
  readonly path: string;
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export const CAUSES: readonly Cause[] = [
  {
    id: "npm-registry-bytes",
    label: "npm registry bytes received",
    unit: "bytes",
    direction: "rising",
    floor: 256 * MiB,
    ceiling: 4 * GiB,
    path: "an install step (`bun install` in `src/checks/service.ts`, an app's install in `src/apps/`) reaching registry.npmjs.org:443 through the egress proxy (`src/apps/egress.ts`, `NPM_REGISTRY`); a cold or unshared bun cache starts it",
  },
  {
    id: "egress-other-bytes",
    label: "bytes received from every other destination (image pulls, git fetch and clone, apps)",
    unit: "bytes",
    direction: "rising",
    floor: 512 * MiB,
    ceiling: 10 * GiB,
    path: "a cell or app reaching a host other than the registry through the egress proxy (`src/apps/egress.ts`, `egressTotals`); the destination is in the forge's /metrics `forge_egress_received_bytes_total`",
  },
  {
    id: "cpu-seconds",
    label: "CPU-seconds used by the forge's machine",
    unit: "seconds",
    direction: "rising",
    floor: 900,
    ceiling: undefined,
    path: "whatever ran hot: the 15 s sampler (`src/boards/sampler.ts`) names cpu per cell label in the `machine` source",
  },
  {
    id: "install-cache-hit-rate",
    label: "install cache hit rate (installs that fetched under 1 MiB from the npm registry)",
    unit: "ratio",
    direction: "falling",
    floor: 0.5,
    ceiling: undefined,
    path: "a contained install (`meteredInstall` in `src/checks/install.ts`) fetching over 1 MiB from the registry because the shared cache (`prefillInstallCache`, `checkInstallCache`) was cold, evicted (`src/checks/install_evict.ts`) or not filled; counted in `src/efficiency/installs.ts`",
  },
];

export const causeOf = (id: string): Cause | undefined => CAUSES.find((c) => c.id === id);

export function show(c: Cause, n: number): string {
  if (c.unit === "ratio") return `${(n * 100).toFixed(1)}%`;
  if (c.unit === "seconds") return `${Math.round(n)} CPU-seconds`;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
}
