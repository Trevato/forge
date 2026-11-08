/**
 * A crew run's cell (#9469): the cgroup `runClaude` puts the agent in, held
 * to its machine's ceilings (`crew/machines.ts`). A machine can only narrow
 * it: memory is capped where today it is not, and cores are the lower of the
 * machine's and the forge's own `FORGE_CREW_CPUS`. A machine that declares
 * nothing (`standard`) gets exactly today's cell: no memory cap, the crew's
 * cores. Where the host cannot hold a declared ceiling, the run's log says
 * so in one line rather than the run silently going uncapped.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CPU_WEIGHT } from "../apps/background.ts";
import { cpuMax, enterArgv, openCellCgroup, tryEnterArgv, type CellCgroup, type CgroupHost } from "../apps/cgroup.ts";

export interface RunLimits {
  readonly memoryMiB?: number | undefined;
  readonly cpus?: number | undefined;
}

/** What the run's cell is asked for: the machine's ceilings, never above the forge's own cores. */
export function cellPlan(limits: RunLimits, crewCpus: number): { memoryMiB: number | undefined; cpus: number } {
  return {
    memoryMiB: limits.memoryMiB,
    cpus: limits.cpus === undefined ? crewCpus : Math.min(limits.cpus, crewCpus),
  };
}

const declared = (limits: RunLimits): string[] => [
  ...(limits.memoryMiB === undefined ? [] : [`memory ${limits.memoryMiB} MiB`]),
  ...(limits.cpus === undefined ? [] : [`${limits.cpus} CPUs`]),
];

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
};

export interface RunCell {
  readonly cgroup: CellCgroup | undefined;
  /** The argv that runs `argv` inside the cell (as it is, without one). */
  readonly wrap: (argv: readonly string[]) => string[];
}

/**
 * Open the run's cell and say, in one log line, which declared ceiling it
 * holds or why the host cannot. Nothing is logged for a machine that
 * declares none. A declared memory cap is entered strictly (the run refuses
 * to start uncapped in a cgroup it was made for); otherwise entering is
 * best effort, as it always was.
 */
export function openRunCell(
  limits: RunLimits,
  host: CgroupHost,
  crewCpus: number,
  log: (line: string) => void,
): RunCell {
  const wanted = declared(limits);
  const plan = cellPlan(limits, crewCpus);
  const bare: RunCell = { cgroup: undefined, wrap: (argv) => [...argv] };
  if (!host.ok) {
    if (wanted.length > 0) log(`machine: ${wanted.join(" and ")} not applied: ${host.reason}`);
    return bare;
  }
  const cgroup = openCellCgroup(plan.memoryMiB, host, { weight: BACKGROUND_CPU_WEIGHT, cpus: plan.cpus });
  if (cgroup === undefined) {
    if (wanted.length > 0) log(`machine: ${wanted.join(" and ")} not applied: the run's cgroup could not be made`);
    return bare;
  }
  if (wanted.length > 0) {
    const held: string[] = [];
    const missed: string[] = [];
    if (limits.memoryMiB !== undefined) held.push(`memory ${limits.memoryMiB} MiB`);
    if (limits.cpus !== undefined) {
      const label = `${plan.cpus} CPUs`;
      (read(join(cgroup.dir, "cpu.max")) === cpuMax(plan.cpus) ? held : missed).push(label);
    }
    log(
      missed.length === 0
        ? `machine: held to ${held.join(" and ")}`
        : `machine: ${missed.join(" and ")} not applied: no cpu controller delegated` +
            (held.length === 0 ? "" : `; held to ${held.join(" and ")}`),
    );
  }
  const procs = join(cgroup.dir, "cgroup.procs");
  return {
    cgroup,
    wrap: (argv) => (limits.memoryMiB === undefined ? tryEnterArgv(procs, argv) : enterArgv(procs, argv)),
  };
}
