/**
 * The machine as one plain object (`/system`, the `system` MCP tool and
 * `/api/v1/telemetry/system`): two raw readings in, rates and groups out.
 * Every process belongs to the cell that launched it (`check:<run>` or
 * `app:<slug>/<env>`), else to the forge itself, else to the host. The same
 * test file under two checks at once is duplicate work, and is named.
 * Command lines are never kept — only `*.test.ts` arguments.
 */
import type { Proc, Raw } from "./proc.ts";
import { TICKS_PER_SECOND } from "./proc.ts";

export type Group = {
  label: string;
  kind: "check" | "app" | "forge" | "host";
  procs: number;
  cpuCores: number | null;
  rssBytes: number;
  /** A cell's memory cap, bytes, and who holds it (`apps/contain.ts`); null for the forge and the host. */
  capBytes: number | null;
  capBy: "kernel" | "watch" | null;
  oldestSeconds: number;
  top: { pid: number; comm: string; cpuCores: number | null; rssBytes: number; ageSeconds: number }[];
  tests: string[];
};

export type Duplicate = { file: string; checks: string[] };

export type SystemView = {
  at: string;
  /** Seconds between the two readings the rates are over; 0 when there was only one. */
  seconds: number;
  cpu: {
    busyPct: number | null;
    cores: (number | null)[];
    /** Each core's last readings, percent, oldest first (kept by `live.ts`; empty from `buildSystem`). */
    history: number[][];
  };
  temps: { chip: string; label: string; celsius: number }[];
  hottestC: number | null;
  load: [number, number, number] | null;
  memory: { totalBytes: number; usedBytes: number; swapUsedBytes: number; swapTotalBytes: number } | null;
  disks: { mount: string; fs: string; totalBytes: number; usedBytes: number }[];
  net: { name: string; rxBytesPerSecond: number | null; txBytesPerSecond: number | null }[];
  io: { name: string; readBytesPerSecond: number | null; writeBytesPerSecond: number | null }[];
  processes: number;
  groups: Group[];
  duplicates: Duplicate[];
};

/** Processes kept per group. */
const TOP = 8;

export type Roots = readonly { label: string; root: number; cap?: { bytes: number; by: "kernel" | "watch" } }[];

const kindOf = (label: string): Group["kind"] =>
  label.startsWith("check:") ? "check" : label.startsWith("app:") ? "app" : label === "forge" ? "forge" : "host";

/** Which group each process is in: the nearest cell root above it, the forge, or the host. */
function groupOf(procs: readonly Proc[], roots: Roots, self: number): Map<number, string> {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const rootLabel = new Map(roots.map((r) => [r.root, r.label]));
  const memo = new Map<number, string>();
  const find = (pid: number): string => {
    const hit = memo.get(pid);
    if (hit !== undefined) return hit;
    let at = pid;
    let found = "host";
    for (let i = 0; i < 64; i++) {
      const label = rootLabel.get(at);
      if (label !== undefined) {
        found = label;
        break;
      }
      if (at === self) {
        found = "forge";
        break;
      }
      const up = by.get(at)?.ppid;
      if (up === undefined || up <= 0) break;
      at = up;
    }
    memo.set(pid, found);
    return found;
  };
  for (const p of procs) find(p.pid);
  return memo;
}

const rate = (a: number | undefined, b: number | undefined, s: number): number | null =>
  a === undefined || b === undefined || s <= 0 || b < a ? null : (b - a) / s;

export function buildSystem(prev: Raw | undefined, next: Raw, roots: Roots, self: number): SystemView {
  const seconds = prev === undefined ? 0 : Math.max(0, (next.at - prev.at) / 1000);
  const cores = next.cores.map((c, i) => {
    const p = prev?.cores[i];
    if (!p || seconds <= 0 || c.total <= p.total) return null;
    return Math.round(((c.busy - p.busy) / (c.total - p.total)) * 1000) / 10;
  });
  const known = cores.filter((c): c is number => c !== null);
  const before = new Map((prev?.procs ?? []).map((p) => [p.pid, p]));
  const where = groupOf(next.procs, roots, self);
  const groups = new Map<string, Group>();
  const caps = new Map(roots.map((r) => [r.label, r.cap]));
  const files = new Map<string, Set<string>>();
  for (const p of next.procs) {
    const label = where.get(p.pid) ?? "host";
    const g =
      groups.get(label) ??
      {
        label,
        kind: kindOf(label),
        procs: 0,
        cpuCores: null,
        rssBytes: 0,
        capBytes: caps.get(label)?.bytes ?? null,
        capBy: caps.get(label)?.by ?? null,
        oldestSeconds: 0,
        top: [],
        tests: [],
      };
    const old = before.get(p.pid);
    const cpu = old && old.age <= p.age ? rate(old.ticks, p.ticks, seconds * TICKS_PER_SECOND) : null;
    g.procs++;
    g.rssBytes += p.rss;
    g.oldestSeconds = Math.max(g.oldestSeconds, Math.round(p.age));
    if (cpu !== null) g.cpuCores = (g.cpuCores ?? 0) + cpu;
    g.top.push({ pid: p.pid, comm: p.comm, cpuCores: cpu, rssBytes: p.rss, ageSeconds: Math.round(p.age) });
    for (const f of p.tests) {
      if (!g.tests.includes(f)) g.tests.push(f);
      if (g.kind === "check") (files.get(f) ?? files.set(f, new Set()).get(f)!).add(label);
    }
    groups.set(label, g);
  }
  for (const g of groups.values()) {
    g.top = g.top
      .sort((a, b) => (b.cpuCores ?? 0) - (a.cpuCores ?? 0) || b.rssBytes - a.rssBytes)
      .slice(0, TOP);
    if (g.cpuCores !== null) g.cpuCores = Math.round(g.cpuCores * 100) / 100;
  }
  const mem = next.memory;
  return {
    at: new Date(next.at).toISOString(),
    seconds,
    cpu: {
      busyPct: known.length === 0 ? null : Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10,
      cores,
      history: [],
    },
    temps: next.temps,
    hottestC: next.temps.length === 0 ? null : Math.max(...next.temps.map((t) => t.celsius)),
    load: next.load,
    memory: mem && {
      totalBytes: mem.total,
      usedBytes: mem.total - mem.available,
      swapUsedBytes: mem.swapTotal - mem.swapFree,
      swapTotalBytes: mem.swapTotal,
    },
    disks: next.disks.map((d) => ({ mount: d.mount, fs: d.fs, totalBytes: d.total, usedBytes: d.used })),
    net: next.net.map((n) => {
      const o = prev?.net.find((x) => x.name === n.name);
      return {
        name: n.name,
        rxBytesPerSecond: rate(o?.rx, n.rx, seconds),
        txBytesPerSecond: rate(o?.tx, n.tx, seconds),
      };
    }),
    io: next.io.map((d) => {
      const o = prev?.io.find((x) => x.name === d.name);
      return { name: d.name, readBytesPerSecond: rate(o?.read, d.read, seconds), writeBytesPerSecond: rate(o?.write, d.write, seconds) };
    }),
    processes: next.procs.length,
    groups: [...groups.values()].sort((a, b) => (b.cpuCores ?? 0) - (a.cpuCores ?? 0) || b.rssBytes - a.rssBytes),
    duplicates: [...files]
      .filter(([, labels]) => labels.size > 1)
      .map(([file, labels]) => ({ file, checks: [...labels].sort() }))
      .sort((a, b) => b.checks.length - a.checks.length || (a.file < b.file ? -1 : 1)),
  };
}

/**
 * What a named agent may read: a private repository's checks and apps keep
 * their place in the totals but lose their name, their test files and their
 * processes. `visible` says whether a label's repository is public.
 */
export function forAgent(view: SystemView, visible: (label: string) => boolean): SystemView {
  const hide = new Map<string, string>();
  const n = { check: 0, app: 0 };
  const name = (label: string): string => {
    if (visible(label) || kindOf(label) === "forge" || kindOf(label) === "host") return label;
    const kind = kindOf(label) as "check" | "app";
    return hide.get(label) ?? hide.set(label, `${kind}:private-${++n[kind]}`).get(label)!;
  };
  return {
    ...view,
    groups: view.groups.map((g) =>
      // The forge and the host hold whatever no labelled cell claims (a crew run in a private clone,
      // an unwatched sandbox): their counts stay, their processes and test files never leave.
      g.kind === "forge" || g.kind === "host"
        ? { ...g, top: [], tests: [] }
        : visible(g.label)
          ? g
          : { ...g, label: name(g.label), top: [], tests: [] },
    ),
    duplicates: view.duplicates
      .map((d) => ({ file: d.checks.every(visible) ? d.file : "(private)", checks: d.checks.map(name).sort() }))
      .sort((a, b) => b.checks.length - a.checks.length),
  };
}
