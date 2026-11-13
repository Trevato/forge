/**
 * Where repository code runs: an app, its preview, its terminal, and every
 * install, test and check step. Each runs in a cell of its own — bubblewrap,
 * the same tool that holds the crew's shell (`crew/sandbox.ts`):
 *
 * - **Files.** The machine is read-only, the forge's data directory and home
 *   are empty, `/tmp` is the cell's own; the only writable places are the
 *   cell's own directories (a checkout, an environment's data, a home).
 * - **Processes.** A pid namespace of its own: nothing outside is visible,
 *   so no other process's environment or memory can be read.
 * - **Network.** A network namespace of its own, with loopback and nothing
 *   else. The way out is the forge's proxy (`apps/egress.ts`), which reaches
 *   the forge and the hosts the repository declared, and refuses the rest.
 *   The way in, for an app, is a relay from the port the forge proxies to.
 * - **Limits.** Memory, CPU and disk are watched from outside, and a cell
 *   over any of them is stopped with the reason, which becomes the step's
 *   error or the app's last log line. Where the forge holds a delegated
 *   cgroup (`apps/cgroup.ts`), memory is also capped by the kernel: a cell
 *   that allocates past it between two ticks is OOM-killed alone.
 *
 * Where the host cannot hold a cell (no bubblewrap, no user namespaces —
 * macOS, or a locked-down container), the code runs as before and every
 * run says so, the way an unsandboxed crew run does.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { portInsteadOfSocket } from "../git/hook-address.ts";
import { relay, startEgress, upstreamProxy, type Egress } from "./egress.ts";
import { BACKGROUND_CPU_WEIGHT } from "./background.ts";
import {
  cgroupHost,
  diskDevice,
  enterArgv,
  openCellCgroup,
  pidsDelegated,
  type CellCgroup,
  type CgroupHost,
  type IoMax,
} from "./cgroup.ts";
import { during } from "../perf/jobs.ts";
import { diskBytes } from "./disk_walk.ts";
import { isSize, SIZES, type Size } from "../spawn/sizes.ts";
import { cpuWatch } from "./cpu_rule.ts";
import { dutyTick, newDuty, resumeNow, type Duty, type DutyLater, type Signaller } from "./cpu_duty.ts";

/** `ceiling`: a declaration was cut to the machine's maximum; `declared`: forge.json's own; `default`: neither. */
export type CeilingFrom = "env" | "pod" | "default" | "size";
export type MemorySource = "ceiling" | "declared" | "default";

export interface Limits {
  /** Resident memory of every process in the cell together, MiB. */
  readonly memoryMiB: number;
  /** Where `memoryMiB` came from, for the line that says it was exceeded. */
  readonly memorySource?: MemorySource | undefined;
  /** Where the machine's memory ceiling came from, named when `memorySource` is `ceiling`. */
  readonly ceilingFrom?: CeilingFrom | undefined;
  /** Cores, averaged over `CPU_WINDOW_MS`. */
  readonly cpus: number;
  /** Bytes on disk under the cell's writable directories, MiB. */
  readonly diskMiB: number;
  /** Wall-clock time of a build step (install, test), ms; unset for an app, which runs on. */
  readonly timeMs?: number | undefined;
}

/** What `forge.json` may ask for (`app.limits`, `check.limits`). */
export type DeclaredLimits = Partial<Limits>;

/** A long-lived app, and a step (install, test, check) that ends. */
export const DEFAULT_LIMITS: Record<"app" | "step", Limits> = {
  app: { memoryMiB: 512, cpus: 1, diskMiB: 1024 },
  step: { memoryMiB: 2048, cpus: 2, diskMiB: 4096, timeMs: 15 * 60_000 },
};

/** The most time a build step may be given, whatever forge.json declares. */
export const STEP_TIME_MAX_MS = 30 * 60_000;

/** The most any declaration gets on this machine. */
export function maxLimits(podFile = POD_MEMORY_FILE, size = ownSize()): Limits {
  const own = size === undefined ? undefined : SIZES[size];
  const disk = positive(process.env["FORGE_CELL_DISK_MAX_MIB"]) ?? 16384;
  return {
    memoryMiB: memoryCeiling(process.env["FORGE_CELL_MEMORY_MAX_MIB"], podFile, size),
    cpus: own === undefined ? availableParallelism() : Math.max(1, Math.min(availableParallelism(), own.cpu)),
    diskMiB: own === undefined ? disk : Math.min(disk, ownShare(own.diskMiB)),
    timeMs: STEP_TIME_MAX_MS,
  };
}

/**
 * The share of a child forge's own size one cell inside it may be given.
 * A child is held to its size as a whole, the forge and every cell in it
 * together (`spawn/cell.ts`); a check granted forge.json's 8 GiB in a large
 * (8 GiB) child took the child over its size and its parent stopped the
 * forge, check and all: "the forge kept going away under this check (4
 * times)" on grokbot-agency. The rest is room for the forge itself.
 */
export const OWN_SIZE_SHARE = 3 / 4;

const ownShare = (mib: number): number => Math.max(1, Math.floor(mib * OWN_SIZE_SHARE));

/** This forge's size when it is a child in a cell (`FORGE_CELL_SIZE`, set by its parent: `cellEnv`); else none. */
function ownSize(): Size | undefined {
  const raw = process.env["FORGE_CELL_SIZE"];
  return isSize(raw) ? raw : undefined;
}

/** The pod's own memory limit, where cgroup v2 states it. */
export const POD_MEMORY_FILE = "/sys/fs/cgroup/memory.max";

/** The share of the pod's memory a single cell may be given. */
export const POD_MEMORY_SHARE = 0.75;

/**
 * The most memory one cell gets, MiB: `FORGE_CELL_MEMORY_MAX_MIB` when set,
 * else a share of the pod's own `memory.max`, else 4096 where the host
 * states no limit. Never a number the host cannot give.
 */
export function memoryCeiling(
  env: string | undefined,
  podFile = POD_MEMORY_FILE,
  size = ownSize(),
): number {
  return ceiling(env, podFile, size).mib;
}

/** Where the ceiling comes from: the variable, the pod's `memory.max`, or the fixed default. */
export function memoryCeilingSource(
  env: string | undefined,
  podFile = POD_MEMORY_FILE,
  size = ownSize(),
): CeilingFrom {
  return ceiling(env, podFile, size).from;
}

/** The machine's ceiling, held under {@link OWN_SIZE_SHARE} of the forge's own size when it is a child. */
function ceiling(
  env: string | undefined,
  podFile: string,
  size: Size | undefined,
): { mib: number; from: CeilingFrom } {
  const machine = machineCeiling(env, podFile);
  if (size === undefined) return machine;
  const own = ownShare(SIZES[size].memoryMiB);
  return own < machine.mib ? { mib: own, from: "size" } : machine;
}

function machineCeiling(
  env: string | undefined,
  podFile: string,
): { mib: number; from: CeilingFrom } {
  const set = positive(env);
  if (set !== undefined) return { mib: set, from: "env" };
  try {
    const bytes = Number(readFileSync(podFile, "utf8").trim());
    if (Number.isFinite(bytes) && bytes > 0)
      return { mib: Math.max(1, Math.floor((bytes * POD_MEMORY_SHARE) / 1048576)), from: "pod" };
  } catch {
    // no cgroup v2 here, or "max" (unlimited): the fixed default below
  }
  return { mib: 4096, from: "default" };
}

/** The line saying a declared memory limit is cut to the machine's ceiling; none when it is not. */
export function limitWarnings(
  declared: DeclaredLimits | undefined,
  podFile = POD_MEMORY_FILE,
): string[] {
  const want = declared?.memoryMiB;
  const have = maxLimits(podFile).memoryMiB;
  return want !== undefined && want > have
    ? [`warning: forge.json declares memory ${want} MiB; this machine grants at most ${have} (${ceilingText(memoryCeilingSource(process.env["FORGE_CELL_MEMORY_MAX_MIB"], podFile))})`]
    : [];
}

/** The ceiling's real source in words: only the variable that is set is named. */
function ceilingText(from: CeilingFrom | undefined): string {
  return from === "env"
    ? "FORGE_CELL_MEMORY_MAX_MIB"
    : from === "size"
      ? `${OWN_SIZE_SHARE * 100}% of this child forge's own size`
      : from === "pod"
        ? `${POD_MEMORY_SHARE * 100}% of the pod's memory.max`
        : "the 4096 MiB default, the host states no memory limit";
}

/** Where a cell's memory limit came from, for the line that says it was exceeded. */
export function memorySource(source: MemorySource | undefined, from?: CeilingFrom): string {
  return source === "ceiling"
    ? `the machine's ceiling, ${ceilingText(from)}; a higher forge.json limit was held to it`
    : source === "declared"
      ? "forge.json limits.memory"
      : "the default";
}

function positive(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The defaults for `kind`, raised or lowered by a declaration, never past the machine's maximum. */
export function resolveLimits(
  kind: "app" | "step",
  declared: DeclaredLimits | undefined,
  podFile = POD_MEMORY_FILE,
): Limits {
  const base = DEFAULT_LIMITS[kind];
  const max = maxLimits(podFile);
  const want = declared?.memoryMiB;
  return {
    memoryMiB: Math.min(want ?? base.memoryMiB, max.memoryMiB),
    memorySource: want === undefined ? "default" : want > max.memoryMiB ? "ceiling" : "declared",
    ceilingFrom: memoryCeilingSource(process.env["FORGE_CELL_MEMORY_MAX_MIB"], podFile),
    cpus: Math.min(declared?.cpus ?? base.cpus, max.cpus),
    diskMiB: Math.min(declared?.diskMiB ?? base.diskMiB, max.diskMiB),
    ...(base.timeMs === undefined
      ? {}
      : { timeMs: Math.min(declared?.timeMs ?? base.timeMs, max.timeMs ?? STEP_TIME_MAX_MS) }),
  };
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A duration in the words a person reads: "15 minutes", "1 second". */
export function durationWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds >= 60 && seconds % 60 === 0 ? plural(seconds / 60, "minute") : plural(seconds, "second");
}

/** MiB as "2 GiB" where it is whole, else "1536 MiB". */
export function sizeWords(mib: number): string {
  return mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
}

/** The one line for a build stopped by its time limit. */
export function timeLine(limits: Limits): string {
  return `the build used its ${durationWords(limits.timeMs ?? DEFAULT_LIMITS.step.timeMs ?? 0)}`;
}

/**
 * The one line for a build the cell stopped, from the watch's reason: which
 * limit, and what it was. Undefined for a reason that is not a limit.
 */
export function breachLine(why: string, limits: Limits): string | undefined {
  if (/memory/.test(why)) return `the build ran out of its ${sizeWords(limits.memoryMiB)}`;
  if (/cores/.test(why)) return `the build used more than its ${plural(limits.cpus, "core")}`;
  if (/disk/.test(why)) return `the build ran out of its ${sizeWords(limits.diskMiB)} of disk`;
  return undefined;
}

/** Always reachable from inside a cell: the npm registry, for install steps. */
export const STEP_HOSTS = ["registry.npmjs.org"];

export interface CellSpec {
  /** The working directory; writable. */
  readonly dir: string;
  /** Other directories the cell may write (an environment's data). */
  readonly writable: readonly string[];
  /** `HOME` inside the cell; created, writable. */
  readonly home: string;
  /** Directories that must look empty inside: the forge's data and home. */
  readonly hide: readonly string[];
  /** Hosts the repository declared (`forge.json` `egress`). */
  readonly egress: readonly string[];
  /** Private `host:port` destinations a site admin granted (`core/egress_grants.ts`). */
  readonly granted?: readonly string[] | undefined;
  /** Origins always reachable: the forge's own URL. */
  readonly reach: readonly string[];
  readonly limits: Limits;
  /** Read-only paths to keep visible when they sit under a hidden directory (a forge's own code). */
  readonly reveal?: readonly string[] | undefined;
  /** The name the cell's processes see as the host's (`cellHostname`); "cell" when unset. */
  readonly hostname?: string | undefined;
  /** The port an app listens on; the forge relays `127.0.0.1:<port>` in. */
  readonly listen?: number | undefined;
  /** Keep the controlling terminal (an app's `tty`). */
  readonly terminal?: boolean | undefined;
  /** Told of every undeclared host let through while egress is only reported. */
  readonly onUndeclared?: ((host: string, port: number) => void) | undefined;
  /** Egress entries allowed since the cell started, asked on every connection (`apps/egress_refused.ts`). */
  readonly allowed?: (() => readonly string[]) | undefined;
  /** Told of every refusal by policy, host and port, and whether it is private. */
  readonly onRefused?: ((host: string, port: number, isPrivate: boolean) => void) | undefined;
  /**
   * Refuse undeclared egress, or only report it, for this cell — the
   * forge's setting when the cell starts (`core/capacity.ts`); enforce
   * when the caller has none. The environment never says (#10778).
   */
  readonly egressMode?: "enforce" | "report" | undefined;
  /**
   * Whose cell this is, for the machine sampler (`boards/sampler.ts`):
   * `check:<run id>` or `app:<slug>/<env>`. An unlabelled cell is watched
   * the same, and never sampled.
   */
  readonly label?: string | undefined;
  /**
   * A step, not an app: its cgroup weighs less than an app's and the
   * forge's, and the kernel holds it to `limits.cpus` cores
   * (`apps/background.ts`). The step runner sets it.
   */
  readonly background?: boolean | undefined;
  /**
   * Held to `limits.cpus` by the kernel (`cpu.max`) at an app's weight: a
   * whole child forge, whose checks and crew run inside it, is slowed when
   * it is busy rather than stopped.
   */
  readonly cpuQuota?: boolean | undefined;
  /** Where the signals of the pausing fallback go; tests only. */
  readonly signal?: Signaller | undefined;
  /**
   * Disk bandwidth the kernel holds the cell to (`io.max`) on the disk
   * under `dir` — the forge's data volume — where io is delegated. A child
   * forge's comes from its size (`spawn/sizes.ts`); unset, no cap.
   */
  readonly io?: IoMax | undefined;
}

/**
 * The limits the watch stops a cell for: the cores only where the kernel
 * does not already hold them. A cell under `cpu.max` cannot run over its
 * cores, and a sampled 4.1 of 4 is the sampling, not the cell.
 */
export function watchedLimits(
  limits: Limits,
  cgroup: { readonly cpuCapped: boolean } | undefined,
  pausing = false,
): Limits {
  return cgroup?.cpuCapped === true || pausing ? { ...limits, cpus: Number.POSITIVE_INFINITY } : limits;
}

export interface Cell {
  /** The argv that runs `command` (through `sh -c`) inside the cell. */
  readonly argv: (command: string) => string[];
  /** `env`, plus what a process inside needs to find its way out. */
  readonly env: (env: Record<string, string>) => Record<string, string>;
  /** Watch the process tree under `pid`; `stop` is called once, with the reason, on a breach. */
  readonly watch: (pid: number, stop: (why: string) => void) => void;
  /** The limit the cell broke, once it has. */
  readonly breach: () => string | undefined;
  /** Stop watching and close the cell's sockets. */
  readonly close: () => void;
  /** The cell's own cgroup directory, where the kernel holds its caps; absent when only the watch does. */
  readonly cgroupDir?: string;
}

// ---- can this host hold a cell? ----

let probed: Promise<{ ok: true } | { ok: false; reason: string }> | undefined;

/**
 * Whether cells work here, asked once with exactly the namespaces and mounts
 * a cell uses. `FORGE_CELLS=off` says no without asking (a developer's
 * machine that wants the old behaviour on purpose).
 */
export function cellsAvailable(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  probed ??= probe();
  return probed;
}

async function probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (process.env["FORGE_CELLS"] === "off")
    return { ok: false, reason: "FORGE_CELLS=off" };
  // A cell reaches its proxy through a unix socket; a sandbox that put the
  // forge on loopback ports (a crew run's `bun test`) cannot bind one.
  if (portInsteadOfSocket())
    return { ok: false, reason: "FORGE_TEST_SOCKET=port: no unix sockets" };
  if (process.platform !== "linux")
    return { ok: false, reason: `no cells on ${process.platform}` };
  for (const tool of ["bwrap", "socat"])
    if (Bun.which(tool) === null)
      return { ok: false, reason: `${tool} is not installed` };
  const verdict = await askUntilBelieved(() => tryOnce());
  // Some hosts hold a cell but refuse its sethostname (EPERM from bwrap's
  // `--hostname`, seen on the check machine): asked once, after the cell is
  // believed, so a refused name costs the cell nothing (#10850).
  if (verdict.ok) hostnameAllowed = (await tryOnce(["--hostname", "cell"])).ok;
  return verdict;
}

/** Whether this host lets a cell set its own hostname; false until `cellsAvailable` has asked. */
let hostnameAllowed = false;

/**
 * The `--hostname` bwrap gets: the cell's own name (`cellHostname`) where
 * the host allows it, nothing where it does not — the cell then keeps the
 * name it was born with, the pod's, rather than not starting at all.
 */
export function hostnameArgs(name: string | undefined, allowed: boolean = hostnameAllowed): string[] {
  return allowed ? ["--hostname", cellHostname(name)] : [];
}

type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * A loaded machine makes a healthy host slow, or briefly out of processes or
 * namespaces, while other checks hold theirs: a refusal is asked again after
 * a pause before it is believed. A host that really refuses therefore costs
 * the pauses (1.5 s in all) before it is reported; the last reason is kept.
 */
export async function askUntilBelieved(
  ask: () => Promise<Verdict>,
  pause: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
): Promise<Verdict> {
  let last = await ask();
  for (let i = 1; i < PROBE_TRIES && !last.ok; i++) {
    await pause(PROBE_PAUSE_MS * i);
    last = await ask();
  }
  return last;
}

const PROBE_TRIES = 3;
const PROBE_PAUSE_MS = 500;
const PROBE_TIMEOUT_MS = 10_000;

async function tryOnce(extra: readonly string[] = []): Promise<Verdict> {
  let timedOut = false;
  try {
    const proc = Bun.spawn(
      [
        "bwrap",
        ...NAMESPACES,
        ...extra,
        "--ro-bind",
        "/",
        "/",
        "--size",
        String(1 << 20),
        "--tmpfs",
        "/tmp",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/bin/true",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(
      () =>
        during("cell-probe-deadline", () => {
          timedOut = true;
          proc.kill("SIGKILL");
        }),
      PROBE_TIMEOUT_MS,
    );
    const [text, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code === 0) return { ok: true };
    const line = text.trim().split("\n").pop() ?? "";
    return {
      ok: false,
      reason: timedOut
        ? `the namespace probe took over ${PROBE_TIMEOUT_MS} ms`
        : `this host refuses the namespaces a cell needs${line === "" ? "" : ` (${line})`}`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const NAMESPACES = [
  "--die-with-parent",
  "--unshare-user",
  "--unshare-pid",
  "--unshare-net",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-cgroup-try",
];

// ---- the cell ----

/** The size of a cell's own `/tmp`, MiB. */
export const TMP_MIB = 256;

/** Open files a process in a cell may hold (`RLIMIT_NOFILE`): sockets count. */
export const FILES_MAX = 8192;
/**
 * Tasks the cell's user may run (`RLIMIT_NPROC`), threads included: the
 * kernel counts them per user namespace (since 5.14, ucounts), so this is
 * the cell's own count. Above `PROCESSES_MAX`, which counts processes, since
 * a Bun process runs a dozen threads; where pids is delegated `pids.max` is
 * the tighter one.
 */
export const TASKS_MAX = 4096;

/**
 * The kernel's limits every process in a cell starts under, set by the
 * cell's first shell with `ulimit` (both soft and hard, so nothing inside
 * raises them; a hard limit already lower stays lower):
 *
 * - `fileBlocks`, `RLIMIT_FSIZE` in 512-byte blocks (dash's `ulimit -f`
 *   unit): no file grows past the cell's disk, so one `fallocate -l 50G`
 *   or `dd` on a small cell fails with SIGXFSZ / EFBIG at once, not at the
 *   watch's next disk walk. It caps a file, not the sum of them: the total
 *   is still the watch's (#10850).
 * - `files`, `RLIMIT_NOFILE`, and `tasks`, `RLIMIT_NPROC`.
 */
export function cellRlimits(limits: Pick<Limits, "diskMiB">): { fileBlocks: number; files: number; tasks: number } {
  const blocks = Number.isFinite(limits.diskMiB) && limits.diskMiB > 0 ? Math.ceil(limits.diskMiB * 2048) : undefined;
  return { fileBlocks: blocks ?? Number.MAX_SAFE_INTEGER, files: FILES_MAX, tasks: TASKS_MAX };
}

/**
 * The name a cell answers `uname -n` and a prompt's `\h` with: its own,
 * never the pod's (the UTS namespace is unshared). Lowercased to a DNS
 * label (RFC 1123: letters, digits, hyphens, at most 63); "cell" when
 * nothing usable is left.
 */
export function cellHostname(name: string | undefined): string {
  const label = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return label === "" ? "cell" : label;
}

/**
 * The line the cell's first shell runs with `cellRlimits`' three figures
 * as `$1 $2 $3`, then drops them. Arguments, never text spliced in.
 * Processes are dash's `-p` and bash's `-u` (bash's `-p` is the pipe size,
 * read-only, so its refusal is silent); `-f` counts 512-byte blocks in dash,
 * the image's `/bin/sh`, and 1024-byte ones in bash, where a file's cap is
 * then twice the disk: still finite.
 */
export const RLIMIT_LINE =
  "ulimit -f $1 2>/dev/null; ulimit -n $2 2>/dev/null; ulimit -u $3 2>/dev/null || ulimit -p $3 2>/dev/null; shift 3";

/** The proxy's port inside every cell. */
const PROXY_PORT = 3128;
const INSIDE = "/run/forge";

/**
 * Started inside the cell before the command: the proxy's front door, the
 * forge's loopback ports, and (for an app) the way in. `sh -c` with the
 * listen port and loopback ports as arguments, then the command's own argv.
 * Each relay is started from a subshell that exits at once, so it belongs to
 * the cell's init and never to the command — whose children are how the
 * forge tells a busy app from an idle one (`apps/busy.ts`).
 */
const WRAPPER = `s=${INSIDE}; listen=$1; shift; loops=$1; shift
${RLIMIT_LINE}
(socat TCP-LISTEN:${PROXY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:$s/out.sock >/dev/null 2>&1 &)
for p in $loops; do (socat TCP-LISTEN:$p,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:$s/loop-$p.sock >/dev/null 2>&1 &); done
[ "$listen" = - ] || (socat UNIX-LISTEN:$s/in.sock,fork,unlink-early TCP:127.0.0.1:$listen >/dev/null 2>&1 &)
i=0; while [ $i -lt 200 ] && ! grep -q ':${PROXY_PORT.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A' /proc/net/tcp 2>/dev/null; do sleep 0.01; i=$((i+1)); done
exec "$@"`;

function origin(url: string): { host: string; port: number } | undefined {
  try {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return undefined;
  }
}

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "::1" || /^127\./.test(host);

/** A path at or under `root`. */
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * What a cell covers and what it shows again, from what the caller names
 * and what the machine mounts (`hiddenMounts`). Deepest last, so a hidden
 * directory never covers a writable one inside it. `/tmp` and `/run` are
 * fresh in every cell, so nothing under them is the machine's: a forge
 * that itself runs in a cell has its own `/run/forge` mounted there, and
 * remounting that read-only would leave the inner cell no socket to listen on.
 */
export function cellMounts(
  spec: Pick<CellSpec, "hide" | "reveal">,
  machine: readonly string[],
  kind: (path: string) => "dir" | "file" | undefined = pathKind,
): { hide: string[]; blank: string[]; reveal: string[] } {
  const hidden = [...new Set([...spec.hide, ...machine])]
    // A path that is not there has nothing to hide (and cannot be mounted
    // over on a read-only root).
    .filter(
      (path) =>
        !["", "/"].includes(path) && !within(path, "/tmp") && !within(path, "/run") && kind(path) !== undefined,
    )
    .sort((a, b) => a.length - b.length);
  // A directory is covered by an empty read-only tmpfs; a file (a secret
  // mounted by itself) by /dev/null.
  const hide = hidden.filter((path) => kind(path) === "dir");
  const blank = hidden.filter((path) => kind(path) === "file");
  // The runtime itself must stay visible when it lives in a hidden home
  // (`~/.bun/bin/bun` on a developer's machine).
  const reveal = [dirname(process.execPath), ...(spec.reveal ?? [])].filter((path) =>
    hide.some((h) => within(path, h)),
  );
  return { hide, blank, reveal };
}

/**
 * A cell's own cgroup on `at`: its memory cap, its share of the cores, and
 * `pids.max` at the watch's process limit where pids is delegated (#10518),
 * and `io.max` on the disk under its directory when it declares `io`.
 */
export function cellCgroup(
  spec: CellSpec,
  at: CgroupHost = cgroupHost(),
  device: (path: string) => string | undefined = diskDevice,
): CellCgroup | undefined {
  const disk = spec.io === undefined || !at.ok ? undefined : device(spec.dir);
  return openCellCgroup(
    spec.limits.memoryMiB,
    at,
    spec.background === true
      ? { weight: BACKGROUND_CPU_WEIGHT, cpus: spec.limits.cpus }
      : spec.cpuQuota === true
        ? { weight: 100, cpus: spec.limits.cpus }
        : undefined,
    PROCESSES_MAX,
    spec.io === undefined || disk === undefined ? undefined : { device: disk, max: spec.io },
  );
}

const cpuHolder: { said: string | undefined } = { said: undefined };

/**
 * Who holds a quota cell's cores: said once per process, and again only if
 * it changes. `forget` starts over (tests).
 */
export function noteCpuHolder(kernel: boolean, log: (line: string) => void, forget = false): string {
  if (forget) cpuHolder.said = undefined;
  const who = kernel ? "the kernel" : "the forge, by pausing";
  if (cpuHolder.said !== who) {
    cpuHolder.said = who;
    log(`cpu: a child forge's cores are held by ${who}`);
  }
  return who;
}

/** Where the next pinned cell's cores begin; `affinityArgv` advances it. */
export interface CoreRotor {
  next: number;
}

/** The process's one rotor: every cell opened here draws its cores from it. */
const cellCores: CoreRotor = { next: 0 };

/**
 * Where the kernel's `cpu.max` is not ours to write, a cell that declares a
 * quota is held to its cores by CPU affinity instead (`taskset -c`, util-linux;
 * sched_setaffinity(2)): a 1-CPU forge builds slowly on one core instead of
 * being stopped. The cores rotate so forges do not all pile on core 0.
 * Nothing is added when the kernel holds the cores, `taskset` is absent, or
 * the cell may have every core the machine has (#11657).
 */
export function affinityArgv(
  spec: Pick<CellSpec, "cpuQuota" | "limits">,
  kernelHolds: boolean,
  rotor: CoreRotor = cellCores,
  machine = availableParallelism(),
  have: boolean = Bun.which("taskset") !== null,
): string[] {
  if (spec.cpuQuota !== true || kernelHolds || !have) return [];
  const n = Math.max(1, Math.ceil(spec.limits.cpus));
  if (!Number.isFinite(n) || n >= machine) return [];
  const first = rotor.next % machine;
  rotor.next = (first + n) % machine;
  const cores = Array.from({ length: n }, (_, i) => (first + i) % machine);
  return ["taskset", "-c", cores.join(",")];
}

/**
 * The argv a cell's command runs as: into its cgroup when it has one, then
 * pinned to its cores when the kernel does not hold them, then `inner` (bwrap).
 */
export function cellArgv(
  inner: readonly string[],
  spec: Pick<CellSpec, "cpuQuota" | "limits">,
  cgroup: { readonly dir: string; readonly cpuCapped: boolean } | undefined,
  rotor: CoreRotor = cellCores,
  machine = availableParallelism(),
  have: boolean = Bun.which("taskset") !== null,
): string[] {
  const pinned = [...affinityArgv(spec, cgroup?.cpuCapped === true, rotor, machine, have), ...inner];
  return cgroup === undefined ? pinned : enterArgv(join(cgroup.dir, "cgroup.procs"), pinned);
}

/** Make a cell: its sockets, its proxy, its relays. `close()` undoes it. */
export function openCell(
  spec: CellSpec,
  log: (line: string) => void = () => {},
): Cell {
  const sockets = mkdtempSync(join(tmpdir(), "fc-"));
  const opened: Egress[] = [];
  const origins = spec.reach.map(origin).filter((o) => o !== undefined);
  const loops = origins.filter((o) => isLoopback(o.host)).map((o) => o.port);
  opened.push(
    startEgress(
      join(sockets, "out.sock"),
      {
        hosts: spec.egress,
        granted: spec.granted,
        label: spec.label,
        allowed: spec.allowed,
        refused: spec.onRefused,
        origins,
        // A cell a child forge opens (its check, app or step) has no way out
        // but the proxy of the cell the child runs in. A child in a cell is
        // the forge told its parent's door; a check that boots a forge is not.
        upstream: process.env["FORGE_PARENT_LOCAL"] === undefined ? undefined : upstreamProxy(),
        report:
          // Enforce unless the caller carries an admin's report (`egressSetting`, #10778).
          spec.egressMode === "report"
            ? (host, port) => spec.onUndeclared?.(host, port)
            : undefined,
      },
      log,
    ),
  );
  for (const port of new Set(loops))
    opened.push(
      relay({ unix: join(sockets, `loop-${port}.sock`) }, { tcp: port }),
    );
  if (spec.listen !== undefined)
    opened.push(
      relay({ tcp: spec.listen }, { unix: join(sockets, "in.sock") }),
    );

  const { hide, blank, reveal } = cellMounts(spec, hiddenMounts());
  const writable = [...new Set([spec.dir, spec.home, ...spec.writable])];
  for (const path of writable) mkdirSync(path, { recursive: true });
  // tmpfs is memory the watch cannot see from outside, so every one is
  // small and bounded, and the ones that only exist to hide are read-only.
  const SMALL = String(1 << 20);

  const cgroup = cellCgroup(spec);
  if (spec.cpuQuota === true) noteCpuHolder(cgroup?.cpuCapped === true, log);
  const argv = (command: string): string[] => cellArgv(bwrapArgv(command), spec, cgroup);
  const rlimits = cellRlimits(spec.limits);
  const bwrapArgv = (command: string): string[] => [
    "bwrap",
    ...NAMESPACES,
    ...hostnameArgs(spec.hostname),
    ...(spec.terminal === true ? [] : ["--new-session"]),
    "--ro-bind", "/", "/",
    "--size", String(TMP_MIB * 1024 * 1024), "--tmpfs", "/tmp",
    "--size", SMALL, "--tmpfs", "/run",
    ...hide.flatMap((path) => ["--size", SMALL, "--tmpfs", path]),
    ...blank.flatMap((path) => ["--ro-bind", "/dev/null", path]),
    ...reveal.flatMap((path) => ["--ro-bind", path, path]),
    ...writable.flatMap((path) => ["--bind", path, path]),
    "--bind", sockets, INSIDE,
    "--remount-ro", "/run",
    ...hide.flatMap((path) => ["--remount-ro", path]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--chdir",
    spec.dir,
    "--",
    "/bin/sh",
    "-c",
    WRAPPER,
    "cell",
    spec.listen === undefined ? "-" : String(spec.listen),
    [...new Set(loops)].join(" "),
    String(rlimits.fileBlocks),
    String(rlimits.files),
    String(rlimits.tasks),
    "/bin/sh",
    "-c",
    command,
  ];

  const env = (base: Record<string, string>): Record<string, string> => {
    const proxy = `http://127.0.0.1:${PROXY_PORT}`;
    return {
      ...base,
      HOME: spec.home,
      TMPDIR: "/tmp",
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    };
  };

  let breach: string | undefined;
  let unwatch: (() => void) | undefined;
  // The kernel's kill leaves no watch tick behind: its count is the reason.
  const killed = (): string | undefined =>
    cgroup !== undefined && cgroup.oomKills() > 0
      ? `reached its ${spec.limits.memoryMiB} MiB memory cap, and the kernel killed it`
      : undefined;
  const watch = (pid: number, stop: (why: string) => void): void => {
    const cap: MemoryCap =
      cgroup === undefined
        ? { bytes: Math.floor(spec.limits.memoryMiB * 1024 * 1024), by: "watch" }
        : { bytes: cgroup.maxBytes, by: "kernel" };
    const paused = spec.cpuQuota === true && cgroup?.cpuCapped !== true;
    unwatch = watchTree(
      pid,
      watchedLimits(spec.limits, cgroup, paused),
      cap,
      writable,
      spec.label,
      (why) => {
        if (breach !== undefined) return;
        breach = why;
        log(`stopped: ${why}`);
        stop(why);
      },
      paused ? { cores: spec.limits.cpus, ...(spec.signal === undefined ? {} : { signal: spec.signal }) } : undefined,
    );
  };
  return {
    argv,
    env,
    watch,
    ...(cgroup === undefined ? {} : { cgroupDir: cgroup.dir }),
    breach: () => breach ?? killed(),
    close: () => {
      const kernel = breach === undefined ? killed() : undefined;
      if (kernel !== undefined) log(`stopped: ${kernel}`);
      cgroup?.remove();
      unwatch?.();
      for (const o of opened) o.close();
      rmSync(sockets, { recursive: true, force: true });
    },
  };
}

/** What is at `path`: a directory, a file, or nothing. */
function pathKind(path: string): "dir" | "file" | undefined {
  if (!existsSync(path)) return undefined;
  return isDirectory(path) ? "dir" : "file";
}

/** Whether `path` is a directory (following links, as bubblewrap will). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** System mounts a cell keeps: its own /dev, /proc, /sys, and the pod's cgroup view. */
const SYSTEM_MOUNT = /^\/(dev|proc|sys)(\/|$)/;

/**
 * Mounts that may carry a secret, read from `/proc/self/mountinfo`: every
 * tmpfs (how Kubernetes mounts a secret, a projected service-account token
 * or a config file of the operator's) outside the cell's own /dev, /proc
 * and /sys, and everything mounted under /run or /var/run. Plus the two
 * places a secret is conventionally put, whether mounted or not.
 */
export function secretMounts(mountinfo = readMountinfo()): string[] {
  const out = new Set(["/run/secrets", "/var/run/secrets"]);
  for (const { path, type } of mountPoints(mountinfo)) {
    if (path === "/" || SYSTEM_MOUNT.test(path)) continue;
    if (type === "tmpfs" || /^\/(var\/)?run\//.test(path)) out.add(path);
  }
  return [...out];
}

/** Files a cell keeps whatever is mounted on them: what a resolver and a hostname need. */
const KEPT_FILES = ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"];

/**
 * How a cell decides which of the machine's mounts it may see.
 * `allow-list`: none but the root, its own /dev, /proc and /sys, the
 * resolver's files and the mounts the runtime and its tools live on —
 * the default inside Kubernetes, where a pod's mounts are ConfigMaps,
 * hostPaths, volumes and secrets the operator put there for the forge.
 * `deny-list`: the machine's mounts minus those that may carry a secret
 * (`secretMounts`) — the default elsewhere, because a developer's machine
 * mounts its system (`/nix/store`, a home) and a cell must still run.
 * `FORGE_CELL_MOUNTS` chooses either.
 */
export function mountMode(): "allow-list" | "deny-list" {
  const set = process.env["FORGE_CELL_MOUNTS"];
  if (set === "allow-list" || set === "deny-list") return set;
  return process.env["KUBERNETES_SERVICE_HOST"] ? "allow-list" : "deny-list";
}

/**
 * Paths whose mounts a cell must see to run at all: where the runtime and
 * the tools a cell starts live, and whatever the operator names in
 * `FORGE_CELL_MOUNTS_KEEP` (`:`-separated, a read-only system mount).
 */
export function keptPaths(): string[] {
  const tools = ["sh", "bwrap", "socat", "git", "bun"]
    .map((tool) => Bun.which(tool))
    .filter((path): path is string => path !== null);
  return [
    dirname(process.execPath),
    ...tools.map((path) => dirname(path)),
    ...(process.env["FORGE_CELL_MOUNTS_KEEP"] ?? "")
      .split(":")
      .filter((path) => path.startsWith("/")),
  ];
}

/** Mount points from mountinfo, unescaped (it writes a space as `\040`). */
function mountPoints(mountinfo: string): { path: string; type: string | undefined }[] {
  const out: { path: string; type: string | undefined }[] = [];
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const point = fields[4];
    if (point === undefined || point === "") continue;
    const dash = fields.indexOf("-");
    out.push({
      path: point.replace(/\\([0-7]{3})/g, (_, o: string) =>
        String.fromCharCode(parseInt(o, 8)),
      ),
      type: dash === -1 ? undefined : fields[dash + 1],
    });
  }
  return out;
}

/** Every mount point a cell hides, in the given mode (`mountMode`). */
export function hiddenMounts(
  mountinfo = readMountinfo(),
  mode = mountMode(),
  kept = keptPaths(),
): string[] {
  const denied = secretMounts(mountinfo);
  if (mode === "deny-list") return denied;
  const out = new Set(denied);
  for (const { path } of mountPoints(mountinfo)) {
    if (path === "/" || SYSTEM_MOUNT.test(path) || KEPT_FILES.includes(path))
      continue;
    // A mount the runtime or a tool lives on (or under) stays.
    if (kept.some((k) => k === path || k.startsWith(`${path}/`))) continue;
    out.add(path);
  }
  return [...out];
}

function readMountinfo(): string {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

// ---- the watch ----

/** How often the process table is read, and over how long CPU is averaged. */
export const WATCH = { tickMs: 1_000, cpuWindowMs: 30_000, diskEveryTicks: 15 };
/** A cell's process limit: the watch's every tick, and the kernel's `pids.max` where pids is delegated. */
export const PROCESSES_MAX = 512;
const CLK_TCK = 100;

interface Watched {
  readonly root: number;
  readonly limits: Limits;
  readonly writable: readonly string[];
  readonly breach: (why: string) => void;
  readonly samples: { at: number; ticks: number }[];
  ticks: number;
  /** A disk walk is out for this cell. */
  measuring?: boolean;
  /** When the cell began to be watched, and since when its cores have held over the stop line without a break (#11657). */
  readonly startedAt: number;
  overSince: number | null;
  readonly key: number;
  readonly label: string | undefined;
  /** Set where the watch holds the cores by pausing the tree (`apps/cpu_duty.ts`). */
  readonly duty?: Duty | undefined;
  readonly signal?: Signaller | undefined;
  /** How the resume is scheduled; the real timer when unset (tests step a clock). */
  readonly later?: DutyLater | undefined;
  /** The memory cap, and who holds it: the kernel (a cgroup) or this watch alone. */
  readonly cap: MemoryCap;
  /** The tree's CPU ticks so far and resident KiB, at the last tick. */
  last?: { ticks: number; kib: number };
}

const watched = new Set<Watched>();
let timer: ReturnType<typeof setInterval> | undefined;
let nextKey = 1;

/** A cell's memory cap, bytes, and who holds it: the kernel (`apps/cgroup.ts`) or the watch alone. */
export interface MemoryCap {
  readonly bytes: number;
  readonly by: "kernel" | "watch";
}

/** Whether cells' memory caps are the kernel's here, or why they are watched only. */
export function memoryCapHolder(): { by: "kernel" } | { by: "watch"; reason: string } {
  const host = cgroupHost();
  return host.ok ? { by: "kernel" } : { by: "watch", reason: host.reason };
}

/** Whether cells' process counts are the kernel's here (`pids.max`), or why they are watched only. */
export function processCapHolder(host: CgroupHost = cgroupHost()): { by: "kernel" } | { by: "watch"; reason: string } {
  if (!host.ok) return { by: "watch", reason: host.reason };
  return pidsDelegated(host)
    ? { by: "kernel" }
    : { by: "watch", reason: "the pids controller is not delegated to the cells" };
}

/** One labelled cell as its watch last read it: cumulative CPU and resident memory. */
export interface CellCounter {
  /** Unique per watched tree, so a rate never spans two processes. */
  readonly key: number;
  readonly label: string;
  /** User + system CPU of every process in the tree, µs (`/proc/<pid>/stat` ticks × 10⁶ / CLK_TCK). */
  readonly cpuUsec: number;
  /** Resident memory of every process in the tree, bytes (`VmRSS`). */
  readonly memoryBytes: number;
  /** Cores used over the watch's CPU window; null until the window has filled. */
  readonly cores?: number | null;
}

/** Cores used since the oldest sample; null until the samples span half the CPU window. */
export function coresOf(
  samples: readonly { at: number; ticks: number }[],
  last: { ticks: number } | undefined,
  now: number,
): number | null {
  const first = samples[0];
  if (first === undefined || last === undefined) return null;
  const span = (now - first.at) / 1000;
  return span >= WATCH.cpuWindowMs / 1000 / 2 ? Math.max(0, (last.ticks - first.ticks) / CLK_TCK / span) : null;
}

/** Every labelled cell the watch has read at least once. */
export function cellCounters(): CellCounter[] {
  const out: CellCounter[] = [];
  for (const e of watched) {
    if (e.label === undefined || e.last === undefined) continue;
    out.push({
      key: e.key,
      label: e.label,
      cpuUsec: (e.last.ticks * 1_000_000) / CLK_TCK,
      memoryBytes: e.last.kib * 1024,
      cores: coresOf(e.samples, e.last, Date.now()),
    });
  }
  return out;
}

/**
 * Kill every process under `root`, deepest first. `root` is bubblewrap,
 * which exits on its own once its child is gone and reaps it on the way;
 * killing it first would leave that child to whoever is pid 1. It gets a
 * second to do so, then the same signal.
 */
export function killTree(root: number): void {
  for (const pid of descendants(root)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  setTimeout(
    () =>
      during("cell-kill-root", () => {
        try {
          process.kill(root, "SIGKILL");
        } catch {
          // gone, as it should be
        }
      }),
    1_000,
  ).unref();
}

/** Send `signal` to every process under `root`, not `root` (bubblewrap) itself. */
export function signalTree(root: number, signal: NodeJS.Signals): void {
  for (const pid of descendants(root)) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * The command's own pid in a cell whose bubblewrap is `root`: the first
 * child of the cell's init (the relays come after it). `undefined` until it
 * exists. `--unshare-user` nests a second bwrap as the only child; step
 * through that so the init we name is the cell's, not the outer wrapper.
 */
export function commandPid(root: number): number | undefined {
  const children = processTable().children;
  let node = root;
  for (;;) {
    const kids = children.get(node) ?? [];
    if (kids.length !== 1) break;
    node = kids[0]!;
  }
  const inside = children.get(node) ?? [];
  if (inside.length === 0) return node === root ? undefined : node;
  // Socat relays start before the command in WRAPPER; skip them so Math.min
  // does not name a relay (or the sh that still holds `bun run`).
  const named = inside.filter((pid) => {
    try {
      return !readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("socat");
    } catch {
      return true;
    }
  });
  const pool = named.length > 0 ? named : inside;
  let pick = Math.min(...pool);
  // The WRAPPER may still show as `sh` holding `bun run` as its child;
  // name the bun — that is what busy asks about.
  for (;;) {
    const kids = children.get(pick) ?? [];
    if (kids.length !== 1) return pick;
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${pick}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      return pick;
    }
    if (!/^\/bin\/sh\b/.test(cmd) && !/^sh\b/.test(cmd)) return pick;
    pick = kids[0]!;
  }
}

function descendants(root: number): number[] {
  const children = processTable().children;
  const order: number[] = [];
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      walk(child);
      order.push(child);
    }
  };
  walk(root);
  return order;
}

export function watchTree(
  root: number,
  limits: Limits,
  cap: MemoryCap,
  writable: readonly string[],
  label: string | undefined,
  breach: (why: string) => void,
  pause?: { readonly cores: number; readonly signal?: Signaller; readonly later?: DutyLater },
): () => void {
  const entry: Watched = {
    root,
    limits,
    writable,
    breach,
    samples: [],
    ticks: 0,
    startedAt: Date.now(),
    overSince: null,
    key: nextKey++,
    label,
    cap,
    ...(pause === undefined ? {} : { duty: newDuty(pause.cores), signal: pause.signal, later: pause.later }),
  };
  const signal = pause?.signal ?? signalTree;
  watched.add(entry);
  timer ??= setInterval(() => during("cell-watch", tick), WATCH.tickMs);
  return () => {
    // A paused tree is always resumed when the watch ends.
    if (entry.duty !== undefined) resumeNow(entry.duty, root, signal);
    watched.delete(entry);
    if (watched.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * Watch the process tree under `pid` as `label`, for a process launched
 * outside `openCell` (a crew run). It is counted in `cellCounters` and
 * `cellRoots` like a cell, but no limit is enforced. Returns the unwatch.
 */
export function watchLabelled(pid: number, label: string): () => void {
  const unlimited: Limits = { memoryMiB: Infinity, cpus: Infinity, diskMiB: Infinity };
  return watchTree(pid, unlimited, { bytes: Infinity, by: "watch" }, [], label, () => {});
}

export interface ProcessRow {
  ppid: number;
  ticks: number;
}

function processTable(): {
  rows: Map<number, ProcessRow>;
  children: Map<number, number[]>;
} {
  const rows = new Map<number, ProcessRow>();
  const children = new Map<number, number[]>();
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return { rows, children };
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    // The command name is in parentheses and may hold spaces; fields after it are fixed.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    const ticks =
      Number(fields[11]) +
      Number(fields[12]) +
      Number(fields[13]) +
      Number(fields[14]);
    const pid = Number(name);
    rows.set(pid, { ppid, ticks });
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  return { rows, children };
}

/**
 * The process of `tree` that has spent the most CPU (its utime + stime +
 * cutime + cstime, in clock ticks, from `/proc/<pid>/stat`), or undefined
 * when none has spent any: who to name when a cell is stopped for CPU
 * (#11509). Its whole life's ticks, not the window's: a per-pid sample on
 * every tick would cost every watched tree, every second, for a line that
 * is written once.
 */
export function busiest(
  tree: readonly number[],
  ticksOf: (pid: number) => number,
): { pid: number; ticks: number } | undefined {
  let top: { pid: number; ticks: number } | undefined;
  for (const pid of tree) {
    const ticks = ticksOf(pid);
    if (ticks > 0 && (top === undefined || ticks > top.ticks)) top = { pid, ticks };
  }
  return top;
}

/**
 * Why a cell was stopped for CPU: cores = Δticks / CLK_TCK / Δseconds over
 * the window, against its limit, and the busiest process when there is
 * one (its CPU seconds = ticks / CLK_TCK, over its life).
 */
export function cpuBreach(
  cores: number,
  seconds: number,
  cpus: number,
  top: { pid: number; ticks: number; name: string } | undefined,
): string {
  const why = `used ${cores.toFixed(1)} cores for ${Math.round(seconds)}s, over twice its limit of ${cpus}`;
  if (top === undefined) return why;
  const spent = Math.round(top.ticks / CLK_TCK);
  return `${why}; the busiest process is ${top.name} (pid ${top.pid}, ${spent}s of CPU)`;
}

/**
 * Whether a step's error is the watch's CPU stop as `runStep` words it
 * (`<step> stopped: it used 16.3 cores for 31s, over twice its limit of 16…`,
 * #11617). Anchored at the start: a failed step's own output only ever
 * follows `<step> exited with code N —`, so a check cannot print its way
 * into reading as stopped for CPU.
 */
export function stoppedForCpu(error: string): boolean {
  return /^[a-z-]+ stopped: it used \d+(?:\.\d+)? cores for \d+s, over (?:twice )?its limit of \d/.test(error);
}

/** A process's command name, printable and short, or "?" once it is gone. */
function commandName(pid: number): string {
  try {
    const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim().replace(/[^\x20-\x7e]/g, "?");
    return name === "" ? "?" : name.slice(0, 32);
  } catch {
    return "?";
  }
}

function residentKiB(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+) kB/m.exec(status);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

export { diskBytes };

let diskWorker: Worker | undefined;
let diskId = 0;
const diskOpen = new Map<number, { resolve: (n: number) => void; reject: (e: Error) => void }>();

/**
 * `diskBytes` taken by a worker: a cell's checkout and its `node_modules` run
 * to a couple of hundred thousand `lstat`s, which held the forge's one thread
 * for 200 to 650 ms every fifteen seconds per cell (45 stalls in ten minutes
 * on production, 2026-11-13).
 */
export function diskBytesOff(dirs: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const id = ++diskId;
    diskOpen.set(id, { resolve, reject });
    try {
      if (diskWorker === undefined) {
        const w = new Worker(new URL("./disk_worker.ts", import.meta.url).href);
        w.onmessage = (e: MessageEvent<{ id: number; bytes?: number; error?: string }>) => {
          const open = diskOpen.get(e.data.id);
          diskOpen.delete(e.data.id);
          if (e.data.error !== undefined) open?.reject(new Error(e.data.error));
          else open?.resolve(e.data.bytes ?? 0);
        };
        w.onerror = () => {
          if (diskWorker === w) diskWorker = undefined;
          for (const [k, open] of diskOpen) {
            diskOpen.delete(k);
            open.reject(new Error("the disk worker failed"));
          }
        };
        w.unref();
        diskWorker = w;
      }
      diskWorker.postMessage({ id, dirs: [...dirs] });
    } catch (error) {
      diskOpen.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const mib = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MiB`;

/** The part of a watched cell its CPU decision reads and keeps. */
export interface CpuState {
  readonly samples: { at: number; ticks: number }[];
  readonly startedAt: number;
  overSince: number | null;
}

/**
 * One tick's CPU decision for a watched cell: record the tree's CPU `ticks`
 * at `now`, average the cores over `WATCH.cpuWindowMs`, keep the hold on
 * `state`, and say whether `cpuWatch` (`apps/cpu_rule.ts`) stops it — with the
 * cores and the seconds the overage has held — or null to let it run (#11657).
 */
export function cpuSample(
  state: CpuState,
  ticks: number,
  cpus: number,
  now: number,
): { cores: number; seconds: number } | null {
  state.samples.push({ at: now, ticks });
  while (state.samples.length > 1 && now - (state.samples[1]?.at ?? now) >= WATCH.cpuWindowMs) state.samples.shift();
  const oldest = state.samples[0];
  if (oldest === undefined || now - oldest.at < WATCH.cpuWindowMs) return null;
  const window = (now - oldest.at) / 1000;
  const cores = (ticks - oldest.ticks) / CLK_TCK / window;
  const verdict = cpuWatch(state.overSince, cores, cpus, now, state.startedAt);
  state.overSince = verdict.overSinceMs;
  // The seconds the overage has held, not the sample window it was averaged over.
  return verdict.stop && verdict.overSinceMs !== null ? { cores, seconds: (now - verdict.overSinceMs) / 1000 } : null;
}

function tick(): void {
  watchTick();
}

/**
 * One tick of the watch over every watched cell, at `now` against `table`.
 * The interval calls it with the clock and `/proc`; tests drive it with a
 * table and a clock of their own.
 */
export function watchTick(
  now = Date.now(),
  table?: { rows: Map<number, ProcessRow>; children: Map<number, number[]> },
): void {
  if (watched.size === 0) return;
  const { rows, children } = table ?? processTable();
  for (const entry of [...watched]) {
    const tree: number[] = [];
    const walk = (pid: number): void => {
      if (!rows.has(pid)) return;
      tree.push(pid);
      for (const child of children.get(pid) ?? []) walk(child);
    };
    walk(entry.root);
    if (tree.length === 0) continue;
    const { limits } = entry;
    if (tree.length > PROCESSES_MAX) {
      entry.breach(
        `${tree.length} processes, over the limit of ${PROCESSES_MAX}`,
      );
      continue;
    }
    let kib = 0;
    let ticks = 0;
    for (const pid of tree) {
      kib += residentKiB(pid);
      ticks += rows.get(pid)?.ticks ?? 0;
    }
    entry.last = { ticks, kib };
    if (entry.duty !== undefined) dutyTick(entry.duty, entry.root, ticks, now, CLK_TCK, entry.signal ?? signalTree, entry.later);
    if (kib > limits.memoryMiB * 1024) {
      entry.breach(
        `used ${mib(kib * 1024)} of memory, over its ${limits.memoryMiB} MiB limit (${memorySource(limits.memorySource, limits.ceilingFrom)})`,
      );
      continue;
    }
    const over = cpuSample(entry, ticks, limits.cpus, now);
    if (over !== null) {
      // Read only now, at the stop: no tick pays for naming a process.
      const top = busiest(tree, (pid) => rows.get(pid)?.ticks ?? 0);
      entry.breach(
        cpuBreach(over.cores, over.seconds, limits.cpus, top === undefined ? undefined : { ...top, name: commandName(top.pid) }),
      );
      continue;
    }
    entry.ticks++;
    if (entry.ticks % WATCH.diskEveryTicks === 0) {
      const over = (bytes: number): void => {
        if (bytes > limits.diskMiB * 1024 * 1024)
          entry.breach(`wrote ${mib(bytes)} to disk, over its ${limits.diskMiB} MiB limit`);
      };
      if (process.env["NODE_ENV"] === "test") over(diskBytes(entry.writable));
      else if (entry.measuring !== true) {
        entry.measuring = true;
        diskBytesOff(entry.writable).then(
          (bytes) => {
            entry.measuring = false;
            if (watched.has(entry)) over(bytes);
          },
          () => {
            entry.measuring = false;
          },
        );
      }
    }
  }
}

/** The root process of every labelled cell being watched, for grouping the process table by what launched it (`system/view.ts`). */
export function cellRoots(): { label: string; root: number; cap: MemoryCap }[] {
  const out: { label: string; root: number; cap: MemoryCap }[] = [];
  for (const e of watched) if (e.label !== undefined) out.push({ label: e.label, root: e.root, cap: e.cap });
  return out;
}
