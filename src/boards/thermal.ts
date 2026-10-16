/**
 * What the machine's thermometers say, for the sampler (`boards/sampler.ts`):
 *
 * - Every `temp<N>_input` under `/sys/class/hwmon/hwmon*` is millidegrees
 *   Celsius (Documentation/hwmon/sysfs-interface.rst), so °C = value / 1000.
 * - Intel's `coretemp` chip labels one input `Package id <P>` and the rest
 *   `Core <K>`, K being the physical core's `core_id`. A logical CPU n is
 *   on core (`physical_package_id`, `core_id`) from
 *   `/sys/devices/system/cpu/cpu<n>/topology/`, so its temperature is that
 *   core's: two hyper-threads of one core read the same thermometer.
 * - A coretemp chip with no `Package id` label is not guessed onto a
 *   package; it and every other chip (k10temp, acpitz, nvme…) is a sensor
 *   of its own, `sensor:<chip>/<label>`.
 *
 * Nothing here is typed by a person, but chip names and labels are still
 * cut to a short, plain alphabet before they become a target.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One thermometer: the chip it is on (its hwmon directory and name), its label, °C. */
export type Reading = { dir: string; chip: string; label: string; celsius: number };

/** Per logical CPU, °C; and every reading no CPU took, as its own target. */
export type Temperatures = {
  perCpu: ReadonlyMap<number, number>;
  sensors: readonly { target: string; celsius: number }[];
};

/** At most this many hwmon chips, and inputs per chip, are read in one tick. */
const MAX_CHIPS = 64;
const MAX_INPUTS = 128;

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function list(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * °C from a `temp<N>_input`: an integer of millidegrees. A value outside
 * −100…250 °C is a sensor saying it is broken (−128000, 255000), not a
 * temperature, and is dropped.
 */
export function parseMillidegrees(text: string | null): number | null {
  const s = text?.trim();
  if (s === undefined || !/^-?\d+$/.test(s)) return null;
  const c = Number(s) / 1000;
  return c > -100 && c < 250 ? c : null;
}

/** A name or label as a target part: printable ASCII from a short set, at most 48 characters. */
export const clean = (s: string) => s.trim().replace(/[^A-Za-z0-9 ._+-]/g, "_").slice(0, 48) || "_";

const byNumber = (prefix: string) => (a: string, b: string) =>
  Number(a.slice(prefix.length)) - Number(b.slice(prefix.length));

/** Every temperature under `<sys>/class/hwmon`, chip by chip in hwmon order, input by input. */
export function readHwmon(sys: string): Reading[] {
  const root = join(sys, "class", "hwmon");
  const out: Reading[] = [];
  const dirs = list(root).filter((d) => /^hwmon\d+$/.test(d)).sort(byNumber("hwmon")).slice(0, MAX_CHIPS);
  for (const dir of dirs) {
    const at = join(root, dir);
    const chip = read(join(at, "name"))?.trim() || dir;
    const inputs = list(at)
      .map((f) => /^temp(\d+)_input$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, MAX_INPUTS);
    for (const n of inputs) {
      const celsius = parseMillidegrees(read(join(at, `temp${n}_input`)));
      if (celsius === null) continue;
      const label = read(join(at, `temp${n}_label`))?.trim() || `temp${n}`;
      out.push({ dir, chip, label, celsius });
    }
  }
  return out;
}

/** Where each logical CPU sits: (package, core) from its topology, or absent when unreadable. */
export function readTopology(sys: string, cpus: readonly number[]): Map<number, { pkg: number; core: number }> {
  const out = new Map<number, { pkg: number; core: number }>();
  for (const n of cpus) {
    const at = join(sys, "devices", "system", "cpu", `cpu${n}`, "topology");
    const pkg = read(join(at, "physical_package_id"))?.trim();
    const core = read(join(at, "core_id"))?.trim();
    if (pkg !== undefined && core !== undefined && /^\d+$/.test(pkg) && /^\d+$/.test(core)) {
      out.set(n, { pkg: Number(pkg), core: Number(core) });
    }
  }
  return out;
}

/** Give each CPU its core's temperature; every other reading becomes a `package:<P>` or `sensor:` target. */
export function temperatures(
  readings: readonly Reading[],
  topology: ReadonlyMap<number, { pkg: number; core: number }>,
): Temperatures {
  const chips = new Map<string, Reading[]>();
  for (const r of readings) chips.set(r.dir, [...(chips.get(r.dir) ?? []), r]);

  const cores = new Map<string, number>();
  const sensors: { target: string; celsius: number }[] = [];
  const seen = new Map<string, number>();
  const sensor = (target: string, celsius: number) => {
    const n = (seen.get(target) ?? 0) + 1;
    seen.set(target, n);
    sensors.push({ target: n === 1 ? target : `${target} #${n}`, celsius });
  };
  for (const rs of chips.values()) {
    const pkg = rs[0]!.chip === "coretemp"
      ? rs.map((r) => /^Package id (\d+)$/.exec(r.label)?.[1]).find((p) => p !== undefined)
      : undefined;
    for (const r of rs) {
      const core = pkg === undefined ? undefined : /^Core (\d+)$/.exec(r.label)?.[1];
      if (pkg !== undefined && r.label === `Package id ${pkg}`) sensor(`package:${pkg}`, r.celsius);
      else if (pkg !== undefined && core !== undefined) cores.set(`${pkg}/${Number(core)}`, r.celsius);
      else sensor(`sensor:${clean(r.chip)}/${clean(r.label)}`, r.celsius);
    }
  }

  const perCpu = new Map<number, number>();
  for (const [n, { pkg, core }] of topology) {
    const c = cores.get(`${pkg}/${core}`);
    if (c !== undefined) perCpu.set(n, c);
  }
  return { perCpu, sensors };
}
