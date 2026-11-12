/**
 * /system reads like btop (#2721): per-core bars with a short history, memory,
 * swap, disk and network rates, and a process table grouped forge / check /
 * crew / app, all from one seeded sample.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLive } from "../src/system/live.ts";
import { parseDiskstats, type Proc, type Raw } from "../src/system/proc.ts";
import { buildSystem, forAgent } from "../src/system/view.ts";
import { regions } from "../src/web/pages/system.ts";
import { content } from "../src/web/style/content.ts";
import { systemLines } from "../src/tui/screens/system.ts";
import { procSortJs, systemLiveJs } from "../src/web/system-live.ts";

const proc = (pid: number, ppid: number, comm: string, ticks: number, rss: number): Proc => ({ pid, ppid, comm, ticks, rss, age: 60, tests: [] });

const raw = (at: number, ticks: number): Raw => ({
  at,
  cores: [{ busy: ticks, total: ticks * 2 }, { busy: 0, total: ticks * 2 }],
  temps: [{ chip: "coretemp", label: "Core 0", celsius: 61 }],
  load: [1, 2, 3],
  memory: { total: 8 * 2 ** 30, available: 2 * 2 ** 30, swapTotal: 2 ** 30, swapFree: 2 ** 29 },
  disks: [{ mount: "/data", fs: "ext4", total: 100 * 2 ** 30, used: 40 * 2 ** 30 }],
  net: [{ name: "eth0", rx: ticks * 1000, tx: ticks * 500 }],
  io: [{ name: "nvme0n1", read: ticks * 4096, write: ticks * 8192 }],
  procs: [
    proc(1, 0, "forge", ticks, 50 << 20),
    proc(200, 1, "bwrap", 0, 1 << 20),
    proc(201, 200, "bun", ticks * 2, 300 << 20),
    proc(300, 1, "bwrap", 0, 1 << 20),
    proc(301, 300, "claude", ticks * 3, 200 << 20),
    proc(400, 1, "bwrap", 0, 1 << 20),
    proc(401, 400, "node", ticks, 100 << 20),
  ],
});

const roots = [
  { label: "check:RUN1", root: 200 },
  { label: "app:other/production", root: 300 },
  { label: "app:notes/production", root: 400 },
];

describe("/system as btop", () => {
  const view = buildSystem(raw(0, 100), raw(2000, 300), roots, 1);

  test("each group — forge, check, app — appears, in that order, with its processes", () => {
    const html = regions(view)["sys-procs"]!;
    const kinds = [...html.matchAll(/<tbody data-kind="(\w+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["forge", "check", "app", "app"]);
    for (const label of ["forge", "check:RUN1", "app:other/production", "app:notes/production"]) expect(html).toContain(label);
    for (const comm of ["bun", "claude", "node"]) expect(html).toContain(`<td class="mono">${comm}</td>`);
    expect(html).toMatch(/data-cpu="[\d.]+" data-mem="\d+"/);
  });

  test("crew:<name> is its own kind, after forge, and another agent never sees its name", () => {
    const r = raw(2000, 300);
    r.procs.push(proc(500, 1, "bwrap", 0, 1 << 20), proc(501, 500, "claude", 10, 80 << 20));
    const v = buildSystem(undefined, r, [...roots.slice(0, 2), { label: "crew:atlas", root: 500 }], 1);
    const html = regions(v)["sys-procs"]!;
    const kinds = [...html.matchAll(/<tbody data-kind="(\w+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["forge", "crew", "check", "app"]);
    expect(v.groups.find((g) => g.label === "crew:atlas")?.kind).toBe("crew");
    const hidden = forAgent(v, () => false);
    expect(JSON.stringify(hidden)).not.toContain("atlas");
    expect(hidden.groups.find((g) => g.kind === "crew")?.label).toBe("crew:private-1");
    expect(hidden.groups.find((g) => g.kind === "crew")?.top).toEqual([]);
    expect(JSON.stringify(forAgent(v, (l) => l === "crew:atlas"))).toContain("crew:atlas");
  });

  test("cores, memory, swap, load, disk and network rates are drawn from the sample", () => {
    const r = regions(view);
    expect(r["cores"]).toContain("cpu0");
    expect(r["cores"]).toContain("cpu1");
    expect(r["cores"]).toContain("<meter");
    expect(r["mem"]).toContain("6.0 GiB / 8.0 GiB");
    expect(r["mem"]).toContain("512 MiB / 1.0 GiB");
    expect(r["mem"]).toContain("1.00  2.00  3.00");
    expect(r["temps"]).toContain("coretemp Core 0 61°C");
    expect(r["sys-disks"]).toContain("/data");
    expect(r["sys-disks"]).toContain("↓ 98 KiB/s ↑ 49 KiB/s");
    expect(r["sys-disks"]).toContain("R 400 KiB/s W 800 KiB/s");
  });

  test("a core's history grows by one reading per sample and is capped", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-btop-"));
    try {
      mkdirSync(join(dir, "proc"), { recursive: true });
      const l = createLive({ paths: { proc: join(dir, "proc"), sys: join(dir, "sys") }, roots: () => [], self: 1 });
      let last = l.read(1_000_000);
      for (let i = 1; i <= 40; i++) {
        writeFileSync(join(dir, "proc/stat"), `cpu0 ${i * 50} 0 0 ${i * 50} 0 0 0 0\n`);
        last = l.read(1_000_000 + i * 2000);
      }
      expect(last.cpu.history[0]!.length).toBe(30);
      expect(last.cpu.history[0]!.at(-1)).toBe(50);
      expect(regions(last)["cores"]).toContain("▅".repeat(5));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the panels are drawn with §5's rows, meters and card, and no .bt-* class remains", () => {
    const r = regions(view);
    const all = Object.values(r).join("\n");
    for (const old of ["bt-bar", "bt-grid", "bt-group", "bt-hist", "bt-name", "bt-procs", "bt-row", "bt-val"]) expect(all).not.toContain(old);
    expect(r["cores"]).toContain('class="row"');
    expect(r["cores"]).toContain('class="row-title"');
    expect(r["cores"]).toContain("<meter");
    expect(r["mem"]).toContain("load");
    expect(r["sys-disks"]).toContain('class="row"');
    expect(r["sys-disks"]).not.toContain("card");
    expect(r["sys-disks"]).toContain('data-io="nvme0n1"');
    expect(r["sys-disks"]).toContain('data-net="eth0"');
    expect(r["sys-procs"]).toContain('class="table"');
    expect(r["sys-procs"]).toContain("2 procs");
  });

  test("the stylesheet no longer carries the retired .bt-* rules (#5250)", () => {
    expect(content).not.toMatch(/\.bt-[a-z]/);
    for (const old of ["bt-bar", "bt-grid", "bt-group", "bt-hist", "bt-name", "bt-procs", "bt-row", "bt-val"]) expect(content).not.toContain(old);
  });

  test("diskstats keep whole devices only", () => {
    const text = " 259 0 nvme0n1 10 0 8 0 20 0 16 0\n 259 1 nvme0n1p1 1 0 2 0 1 0 2 0\n   7 0 loop0 1 0 2 0 0 0 0 0\n";
    expect(parseDiskstats(text, (n) => n === "nvme0n1")).toEqual([{ name: "nvme0n1", read: 8 * 512, write: 16 * 512 }]);
  });

  test("a meter has an accessible name, and the sort buttons need a script", async () => {
    const r = regions(view);
    expect(r["cores"]).toContain('aria-label="cpu0 ');
    expect(r["mem"]).toContain('aria-label="swap 512 MiB / 1.0 GiB"');
    const page = await Bun.file("src/web/pages/system.ts").text();
    expect(page).toMatch(/class="js-only[^"]*">Sort by[\s\S]*data-sort="mem"/);
  });

  test("the sort puts kinds in order and the biggest first by CPU or memory, ties staying put", () => {
    const rank = new Function(`${procSortJs}; return rank;`)() as (
      items: { kind?: string; cpu: number; mem: number; id: string }[],
      key: "cpu" | "mem",
      kinds: string[],
    ) => { id: string }[];
    const items = [
      { id: "app-small", kind: "app", cpu: 1, mem: 9 },
      { id: "check-a", kind: "check", cpu: 2, mem: 1 },
      { id: "forge", kind: "forge", cpu: 0, mem: 5 },
      { id: "check-b", kind: "check", cpu: 5, mem: 3 },
      { id: "check-c", kind: "check", cpu: 5, mem: 2 },
    ];
    const kinds = ["forge", "check", "app", "host"];
    expect(rank(items, "cpu", kinds).map((i) => i.id)).toEqual(["forge", "check-b", "check-c", "check-a", "app-small"]);
    expect(rank(items, "mem", kinds).map((i) => i.id)).toEqual(["forge", "check-b", "check-c", "check-a", "app-small"]);
    expect(rank(items.filter((i) => i.kind === "check"), "mem", []).map((i) => i.id)).toEqual(["check-b", "check-c", "check-a"]);
    expect(rank(items, "cpu", kinds).length).toBe(5);
    expect(items[0]!.id).toBe("app-small");
  });

  test("hotkeys are ignored on a focused button or link, except the sort buttons", () => {
    expect(systemLiveJs).toContain("(tag === 'BUTTON' || tag === 'A') && !(t.hasAttribute && t.hasAttribute('data-sort'))");
  });

  test("the terminal's System view has the cores with history, swap, rates and the top processes", () => {
    const lines = systemLines(JSON.parse(JSON.stringify({ ...view, cpu: { ...view.cpu, history: [[0, 50, 100], [10]] } })));
    const text = lines.join("\n");
    expect(text).toContain("cpu0");
    expect(text).toContain("▁▅█");
    expect(text).toContain("swap 512 MiB of 1.0 GiB");
    expect(text).toContain("R 400 KiB/s  W 800 KiB/s");
    expect(text).toContain("↓ 98 KiB/s  ↑ 49 KiB/s");
    expect(text).toMatch(/bun\s+\d+\.\d+ cores/);
    expect(text).toContain("check:RUN1");
  });
});
