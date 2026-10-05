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
 * - **Limits.** Memory, CPU and disk are watched from outside (a container
 *   cannot create cgroups), and a cell over any of them is stopped with the
 *   reason, which becomes the step's error or the app's last log line.
 *
 * Where the host cannot hold a cell (no bubblewrap, no user namespaces —
 * macOS, or a locked-down container), the code runs as before and every
 * run says so, the way an unsandboxed crew run does.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { relay, startEgress, type Egress } from "./egress.ts";

export interface Limits {
  /** Resident memory of every process in the cell together, MiB. */
  readonly memoryMiB: number;
  /** Cores, averaged over `CPU_WINDOW_MS`. */
  readonly cpus: number;
  /** Bytes on disk under the cell's writable directories, MiB. */
  readonly diskMiB: number;
}

/** What `forge.json` may ask for (`app.limits`, `check.limits`). */
export type DeclaredLimits = Partial<Limits>;

/** A long-lived app, and a step (install, test, check) that ends. */
export const DEFAULT_LIMITS: Record<"app" | "step", Limits> = {
  app: { memoryMiB: 512, cpus: 1, diskMiB: 1024 },
  step: { memoryMiB: 2048, cpus: 2, diskMiB: 4096 },
};

/** The most any declaration gets on this machine. */
export function maxLimits(): Limits {
  return {
    memoryMiB: positive(process.env["FORGE_CELL_MEMORY_MAX_MIB"]) ?? 4096,
    cpus: availableParallelism(),
    diskMiB: positive(process.env["FORGE_CELL_DISK_MAX_MIB"]) ?? 16384,
  };
}

function positive(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The defaults for `kind`, raised or lowered by a declaration, never past the machine's maximum. */
export function resolveLimits(
  kind: "app" | "step",
  declared: DeclaredLimits | undefined,
): Limits {
  const base = DEFAULT_LIMITS[kind];
  const max = maxLimits();
  return {
    memoryMiB: Math.min(declared?.memoryMiB ?? base.memoryMiB, max.memoryMiB),
    cpus: Math.min(declared?.cpus ?? base.cpus, max.cpus),
    diskMiB: Math.min(declared?.diskMiB ?? base.diskMiB, max.diskMiB),
  };
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
  /** Origins always reachable: the forge's own URL. */
  readonly reach: readonly string[];
  readonly limits: Limits;
  /** The port an app listens on; the forge relays `127.0.0.1:<port>` in. */
  readonly listen?: number | undefined;
  /** Keep the controlling terminal (an app's `tty`). */
  readonly terminal?: boolean | undefined;
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
  if (process.platform !== "linux")
    return { ok: false, reason: `no cells on ${process.platform}` };
  for (const tool of ["bwrap", "socat"])
    if (Bun.which(tool) === null)
      return { ok: false, reason: `${tool} is not installed` };
  try {
    const proc = Bun.spawn(
      [
        "bwrap",
        ...NAMESPACES,
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
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    const [text, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code === 0) return { ok: true };
    const line = text.trim().split("\n").pop() ?? "";
    return {
      ok: false,
      reason: `this host refuses the namespaces a cell needs${line === "" ? "" : ` (${line})`}`,
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

/** The proxy's port inside every cell. */
const PROXY_PORT = 3128;
const INSIDE = "/run/forge";

/**
 * Started inside the cell before the command: the proxy's front door, the
 * forge's loopback ports, and (for an app) the way in. `sh -c` with the
 * listen port and loopback ports as arguments, then the command's own argv.
 */
const WRAPPER = `s=${INSIDE}; listen=$1; shift; loops=$1; shift
socat TCP-LISTEN:${PROXY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:$s/out.sock >/dev/null 2>&1 &
for p in $loops; do socat TCP-LISTEN:$p,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:$s/loop-$p.sock >/dev/null 2>&1 & done
[ "$listen" = - ] || socat UNIX-LISTEN:$s/in.sock,fork,unlink-early TCP:127.0.0.1:$listen >/dev/null 2>&1 &
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
      { hosts: spec.egress, origins },
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

  // Deepest last, so a hidden directory never covers a writable one inside it.
  const hide = [...new Set(spec.hide)]
    .filter((path) => path !== "/" && path !== "")
    .sort((a, b) => a.length - b.length);
  // The runtime itself must stay visible when it lives in a hidden home
  // (`~/.bun/bin/bun` on a developer's machine).
  const reveal = [dirname(process.execPath)].filter((path) =>
    hide.some((h) => path === h || path.startsWith(`${h}/`)),
  );
  const writable = [...new Set([spec.dir, spec.home, ...spec.writable])];
  for (const path of writable) mkdirSync(path, { recursive: true });
  // tmpfs is memory the watch cannot see from outside, so every one is
  // small and bounded, and the ones that only exist to hide are read-only.
  const SMALL = String(1 << 20);

  const argv = (command: string): string[] => [
    "bwrap",
    ...NAMESPACES,
    ...(spec.terminal === true ? [] : ["--new-session"]),
    "--ro-bind", "/", "/",
    "--size", String(TMP_MIB * 1024 * 1024), "--tmpfs", "/tmp",
    "--size", SMALL, "--tmpfs", "/run",
    ...hide.flatMap((path) => ["--size", SMALL, "--tmpfs", path]),
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
  const watch = (pid: number, stop: (why: string) => void): void => {
    unwatch = watchTree(pid, spec.limits, writable, (why) => {
      if (breach !== undefined) return;
      breach = why;
      log(`stopped: ${why}`);
      stop(why);
    });
  };
  return {
    argv,
    env,
    watch,
    breach: () => breach,
    close: () => {
      unwatch?.();
      for (const o of opened) o.close();
      rmSync(sockets, { recursive: true, force: true });
    },
  };
}

// ---- the watch ----

/** How often the process table is read, and over how long CPU is averaged. */
export const WATCH = { tickMs: 1_000, cpuWindowMs: 30_000, diskEveryTicks: 15 };
const PROCESSES_MAX = 512;
const CLK_TCK = 100;
const DISK_WALK_MAX = 200_000;

interface Watched {
  readonly root: number;
  readonly limits: Limits;
  readonly writable: readonly string[];
  readonly breach: (why: string) => void;
  readonly samples: { at: number; ticks: number }[];
  ticks: number;
}

const watched = new Set<Watched>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Kill every process under `root`, deepest first, then `root` itself. */
export function killTree(root: number): void {
  for (const pid of [...descendants(root), root]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
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

function watchTree(
  root: number,
  limits: Limits,
  writable: readonly string[],
  breach: (why: string) => void,
): () => void {
  const entry: Watched = {
    root,
    limits,
    writable,
    breach,
    samples: [],
    ticks: 0,
  };
  watched.add(entry);
  timer ??= setInterval(tick, WATCH.tickMs);
  return () => {
    watched.delete(entry);
    if (watched.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

interface ProcessRow {
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

function residentKiB(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+) kB/m.exec(status);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** Bytes allocated under `dirs`, without following links, bounded. */
export function diskBytes(dirs: readonly string[]): number {
  let total = 0;
  let seen = 0;
  const walk = (path: string): void => {
    if (++seen > DISK_WALK_MAX) return;
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    total += st.blocks * 512;
    if (!st.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) walk(join(path, name));
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir);
  return total;
}

const mib = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MiB`;

function tick(): void {
  if (watched.size === 0) return;
  const { rows, children } = processTable();
  const now = Date.now();
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
    if (kib > limits.memoryMiB * 1024) {
      entry.breach(
        `used ${mib(kib * 1024)} of memory, over its ${limits.memoryMiB} MiB limit`,
      );
      continue;
    }
    entry.samples.push({ at: now, ticks });
    while (
      entry.samples.length > 1 &&
      now - (entry.samples[1]?.at ?? now) >= WATCH.cpuWindowMs
    )
      entry.samples.shift();
    const oldest = entry.samples[0];
    if (oldest !== undefined && now - oldest.at >= WATCH.cpuWindowMs) {
      const cores =
        (ticks - oldest.ticks) / CLK_TCK / ((now - oldest.at) / 1000);
      if (cores > limits.cpus) {
        entry.breach(
          `used ${cores.toFixed(1)} cores for ${Math.round((now - oldest.at) / 1000)}s, over its limit of ${limits.cpus}`,
        );
        continue;
      }
    }
    entry.ticks++;
    if (entry.ticks % WATCH.diskEveryTicks === 0) {
      const bytes = diskBytes(entry.writable);
      if (bytes > limits.diskMiB * 1024 * 1024)
        entry.breach(
          `wrote ${mib(bytes)} to disk, over its ${limits.diskMiB} MiB limit`,
        );
    }
  }
}
