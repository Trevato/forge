/**
 * What the machine is doing right now, read from /proc and /sys and nothing
 * else: per-core ticks, temperatures (hwmon), memory, load, disk per mount,
 * network, and every process with its parent, CPU ticks, resident memory
 * and start. Plain data out; a file that is missing or unreadable leaves its
 * series empty, never a guess. Paths are a parameter so a test can hand it a
 * directory it wrote.
 */
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";

export type Paths = { proc: string; sys: string };
export const HOST: Paths = { proc: "/proc", sys: "/sys" };

const HZ = 100;
const PAGE = 4096;
const PROCESSES_MAX = 20_000;
const MOUNTS_MAX = 24;

export type CoreTicks = { busy: number; total: number };
export type Temp = { chip: string; label: string; celsius: number };
export type Memory = { total: number; available: number; swapTotal: number; swapFree: number };
export type Disk = { mount: string; fs: string; total: number; used: number };
export type Nic = { name: string; rx: number; tx: number };
/** Bytes read and written since boot by one whole block device. */
export type Io = { name: string; read: number; write: number };
export type Proc = {
  pid: number;
  ppid: number;
  comm: string;
  ticks: number;
  rss: number;
  /** Seconds since it started. */
  age: number;
  /** The `*.test.ts` files named in its arguments, nothing else of its command line. */
  tests: string[];
};

export type Raw = {
  at: number;
  cores: CoreTicks[];
  temps: Temp[];
  load: [number, number, number] | null;
  memory: Memory | null;
  disks: Disk[];
  net: Nic[];
  io: Io[];
  procs: Proc[];
};

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const num = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** One entry per `cpuN` line of /proc/stat: busy and total ticks. */
export function parseCores(text: string | null): CoreTicks[] {
  const out: CoreTicks[] = [];
  for (const m of (text ?? "").matchAll(/^cpu(\d+) +(.*)$/gm)) {
    const f = m[2]!.trim().split(/\s+/).map(num);
    const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    out[Number(m[1])] = { busy: total - idle, total };
  }
  return out.filter((c) => c !== undefined);
}

export function parseMemory(text: string | null): Memory | null {
  if (text === null) return null;
  const kb = (k: string): number => {
    const m = new RegExp(`^${k}:\\s+(\\d+) kB$`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  // No MemAvailable (an old kernel, a cut file) is unknown, not zero bytes free.
  return total === 0 || available === 0 ? null : { total, available, swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
}

export function parseLoad(text: string | null): [number, number, number] | null {
  const f = text?.trim().split(/\s+/).slice(0, 3).map(Number);
  return f && f.length === 3 && f.every(Number.isFinite) ? [f[0]!, f[1]!, f[2]!] : null;
}

export function parseNet(text: string | null): Nic[] {
  const out: Nic[] = [];
  for (const line of (text ?? "").split("\n").slice(2)) {
    const m = /^\s*([\w.@-]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === "lo") continue;
    const f = m[2]!.trim().split(/\s+/);
    out.push({ name: m[1]!, rx: num(f[0]), tx: num(f[8]) });
  }
  return out;
}

const SECTOR = 512;
const DEVICES_MAX = 16;

/** The whole devices of /proc/diskstats (`whole` says which names are not partitions or loop/ram devices). */
export function parseDiskstats(text: string | null, whole: (name: string) => boolean): Io[] {
  const out: Io[] = [];
  for (const line of (text ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    const name = f[2];
    if (!name || !/^[\w.-]{1,32}$/.test(name) || /^(loop|ram|zram|dm-)/.test(name) || !whole(name)) continue;
    out.push({ name, read: num(f[5]) * SECTOR, write: num(f[9]) * SECTOR });
    if (out.length >= DEVICES_MAX) break;
  }
  return out;
}

/** The `stat` line of one process; null when it is not one. */
export function parseProcStat(text: string): { comm: string; ppid: number; ticks: number; rss: number; start: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 2).split(" ");
  if (f.length < 22) return null;
  return {
    comm: text.slice(open + 1, close).slice(0, 32),
    ppid: num(f[1]),
    ticks: num(f[11]) + num(f[12]),
    rss: num(f[21]) * PAGE,
    start: num(f[19]) / HZ,
  };
}

const TEST_FILE = /^(?:\.\/)?[\w@.+/-]{1,200}\.test\.ts$/;

/** The test files an argument vector names: only arguments shaped like one, so nothing else of a command line is kept. */
export function testFiles(cmdline: string | null): string[] {
  if (!cmdline) return [];
  const seen = new Set<string>();
  for (const arg of cmdline.split("\0")) if (TEST_FILE.test(arg)) seen.add(arg.replace(/^\.\//, ""));
  return [...seen].slice(0, 16);
}

export function readTemps(sys: string): Temp[] {
  const out: Temp[] = [];
  const base = join(sys, "class/hwmon");
  let chips: string[] = [];
  try {
    chips = readdirSync(base).filter((n) => /^hwmon\d+$/.test(n));
  } catch {
    return out;
  }
  for (const chip of chips) {
    const dir = join(base, chip);
    const name = read(join(dir, "name"))?.trim() ?? chip;
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((n) => /^temp\d+_input$/.test(n));
    } catch {
      continue;
    }
    for (const f of files) {
      const milli = Number(read(join(dir, f))?.trim());
      if (!Number.isFinite(milli)) continue;
      const label = read(join(dir, f.replace("_input", "_label")))?.trim() ?? f.replace("_input", "");
      out.push({ chip: name.slice(0, 32), label: label.slice(0, 48), celsius: milli / 1000 });
    }
  }
  return out;
}

const REAL_FS = new Set(["ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "overlay", "nfs", "nfs4"]);

export function readDisks(proc: string): Disk[] {
  const out: Disk[] = [];
  const seen = new Set<string>();
  for (const line of (read(join(proc, "mounts")) ?? "").split("\n")) {
    const [dev, mount, fs] = line.split(" ");
    if (!dev || !mount || !fs || !REAL_FS.has(fs) || seen.has(dev + fs)) continue;
    seen.add(dev + fs);
    try {
      const s = statfsSync(mount.replace(/\\040/g, " "));
      const total = s.blocks * s.bsize;
      if (total > 0) out.push({ mount: mount.replace(/\\040/g, " "), fs, total, used: total - s.bfree * s.bsize });
    } catch {
      // unreadable mount: absent, not guessed
    }
    if (out.length >= MOUNTS_MAX) break;
  }
  return out;
}

export function readProcs(proc: string): Proc[] {
  let names: string[] = [];
  try {
    names = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  const up = num(read(join(proc, "uptime"))?.split(" ")[0]);
  const out: Proc[] = [];
  for (const name of names.slice(0, PROCESSES_MAX)) {
    const text = read(join(proc, name, "stat"));
    const s = text === null ? null : parseProcStat(text);
    if (!s) continue;
    const isBun = /^(bun|node)/.test(s.comm);
    out.push({
      pid: Number(name),
      ppid: s.ppid,
      comm: s.comm,
      ticks: s.ticks,
      rss: s.rss,
      age: Math.max(0, up - s.start),
      // Only a runner of tests can be running a test file; skip the cmdline read for the rest.
      tests: isBun ? testFiles(read(join(proc, name, "cmdline"))) : [],
    });
  }
  return out;
}

export function readRaw(paths: Paths, at: number): Raw {
  return {
    at,
    cores: parseCores(read(join(paths.proc, "stat"))),
    temps: readTemps(paths.sys),
    load: parseLoad(read(join(paths.proc, "loadavg"))),
    memory: parseMemory(read(join(paths.proc, "meminfo"))),
    disks: readDisks(paths.proc),
    net: parseNet(read(join(paths.proc, "net/dev"))),
    io: parseDiskstats(read(join(paths.proc, "diskstats")), (n) => existsSync(join(paths.sys, "block", n))),
    procs: readProcs(paths.proc),
  };
}

export const TICKS_PER_SECOND = HZ;
