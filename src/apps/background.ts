/**
 * The forge's serving process outranks the work it starts (#3319). A full
 * lane of checks and crew runs once took 30 cores beside the forge, its
 * `/healthz` timed out, and the pod left the endpoints: the children were
 * scheduled as equals of the process that answers every page. Every check
 * step and every crew run now starts in the background class:
 *
 * - **CPU, by scheduler.** `SCHED_BATCH` (sched(7): "the scheduler will
 *   apply a small scheduling penalty with respect to wakeup behavior, so
 *   that this thread is mildly disfavored in scheduling decisions") and
 *   nice 10 — a weight of 110 against the forge's 1024 at nice 0
 *   (`sched_prio_to_weight`, kernel/sched/core.c): on a core it shares
 *   with one such thread, the forge gets 1024 / 1134 ≈ 90% of the time.
 * - **IO.** Best-effort class, level 7 — the lowest that is never starved
 *   (ioprio_set(2); "idle" would wait forever behind a forge that is
 *   always writing a little).
 * - **CPU and IO, by cgroup.** Where the forge holds a delegated cgroup
 *   (`apps/cgroup.ts`), nice orders threads only within one cgroup, so the
 *   forge's own leaf weighs 1000 against the cells' 100, and a step's cell
 *   weighs 10 against an app's 100 among them. Each crew run gets a cell
 *   cgroup of its own at the same weight (it ran in the forge's leaf,
 *   where nice was the only difference).
 * - **The pod's own CFS quota is not a priority, and was the stall.** A
 *   container run with `--cpus N` is held by `cpu.max`: once the work in
 *   it has spent N cores' worth of a 100 ms period, the kernel freezes
 *   every thread of the container, the serving thread included, until the
 *   next period. Measured with 24 background burners on 8 cores (2026-11-13):
 *   the page's p50 went 5 ms → 35 ms and all 420 periods were throttled
 *   (nice and SCHED_BATCH cannot help: the freeze is above the scheduler's
 *   class); the same cores as a cpuset with no quota gave p50 4 ms, p99
 *   17 ms (idle 10), and unlowered children 64 burners p99 230 ms. So the
 *   forge's container is bounded by `--cpuset-cpus`, which never throttles,
 *   and the work by this class and its own concurrency.
 * - **CPU, by quota.** Each step's cell is held to its declared cores
 *   (`check.limits.cpus`, `cpu.max`) and each crew run to
 *   `FORGE_CREW_CPUS` (default 4): one busy check slows itself, and cannot
 *   take the pod's whole quota while the forge waits for its turn.
 *
 * Each is asked for and none is required: a host without `chrt` or
 * `ionice`, or one that refuses the call, runs the work at the priority it
 * had. An app's own process is not lowered — it serves people too.
 */

/** The niceness every background child runs at (nice(1)): 0 is the forge's, 19 the lowest. */
export const BACKGROUND_NICE = 10;
/** Best-effort IO class (2) at its lowest level (7), ionice(1). */
export const BACKGROUND_IO = { class: 2, level: 7 } as const;
/** A step cell's `cpu.weight` (cgroup v2, 1–10000; the default is 100). */
export const BACKGROUND_CPU_WEIGHT = 10;
/** Cores one crew run may use where `FORGE_CREW_CPUS` does not say. */
export const CREW_CPUS = 4;

/** `FORGE_CREW_CPUS`: a number of cores above 0 and at most 1024, or the default. */
export function crewCpus(raw: string | undefined = process.env["FORGE_CREW_CPUS"]): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 && n <= 1024 ? n : CREW_CPUS;
}

/**
 * Lower the shell's own priority, then become `argv`, so the child and
 * everything it starts inherit the background class from their first
 * instruction. Each step's failure is silenced and ignored; `argv` always
 * runs. No caller text reaches the script: `argv` is arguments, never code.
 */
export function backgroundArgv(argv: readonly string[]): string[] {
  return [
    "/bin/sh",
    "-c",
    "chrt -b -p 0 $$ >/dev/null 2>&1; " +
      `ionice -c ${BACKGROUND_IO.class} -n ${BACKGROUND_IO.level} -p $$ >/dev/null 2>&1; ` +
      `command -v nice >/dev/null 2>&1 && exec nice -n ${BACKGROUND_NICE} "$@"; exec "$@"`,
    "background",
    ...argv,
  ];
}
