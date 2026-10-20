/**
 * OpenMetrics text exposition (spec 1.0) from plain data: counter, gauge and
 * histogram families in, one string ending in `# EOF` out. It runs no query
 * and reads nothing; whatever is wrong with the data throws.
 */

export type Labels = Record<string, string>;

export type Sample = { labels?: Labels; value: number };

export type HistogramSample = {
  labels?: Labels;
  /** Finite upper bounds, strictly rising, with cumulative counts. `+Inf` is added from `count`. */
  buckets: { le: number; count: number }[];
  count: number;
  sum: number;
};

export type Family =
  | { type: "counter" | "gauge"; name: string; help: string; samples: Sample[] }
  | { type: "histogram"; name: string; help: string; samples: HistogramSample[] };

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function checkName(name: string): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`invalid metric name: ${String(name)}`);
  return name;
}

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

export function formatNumber(n: number): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

function labelSet(labels: Labels | undefined, extra?: [string, string]): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (!LABEL.test(k) || k.startsWith("__")) throw new Error(`invalid label name: ${k}`);
    if (typeof v !== "string") throw new Error(`label ${k} must be a string`);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (extra) pairs.push(extra);
  if (pairs.length === 0) return "";
  return `{${pairs.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`;
}

function checkCount(n: number, what: string): void {
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a finite number >= 0`);
}

function histogramLines(base: string, s: HistogramSample, out: string[]): void {
  if (Object.hasOwn(s.labels ?? {}, "le")) throw new Error(`histogram ${base} may not carry a label named le`);
  checkCount(s.count, `${base} count`);
  if (!Number.isFinite(s.sum)) throw new Error(`${base} sum must be finite`);
  let prevLe = -Infinity;
  let prevCount = 0;
  for (const b of s.buckets) {
    if (!Number.isFinite(b.le) || b.le <= prevLe) throw new Error(`${base} bucket bounds must be finite and rising`);
    checkCount(b.count, `${base} bucket`);
    if (b.count < prevCount) throw new Error(`${base} buckets must be cumulative`);
    prevLe = b.le;
    prevCount = b.count;
    out.push(`${base}_bucket${labelSet(s.labels, ["le", formatNumber(b.le)])} ${b.count}`);
  }
  if (s.count < prevCount) throw new Error(`${base} count is below its last bucket`);
  out.push(`${base}_bucket${labelSet(s.labels, ["le", "+Inf"])} ${s.count}`);
  out.push(`${base}_count${labelSet(s.labels)} ${s.count}`);
  out.push(`${base}_sum${labelSet(s.labels)} ${formatNumber(s.sum)}`);
}

const SUFFIXES = { counter: ["_total"], gauge: [""], histogram: ["_bucket", "_count", "_sum"] } as const;

export function openMetrics(families: Family[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const sampleNames = new Set<string>();
  for (const f of families) {
    if (!Object.hasOwn(SUFFIXES, f.type)) throw new Error(`invalid metric type: ${String(f.type)}`);
    checkName(f.name);
    // The family of a counter is named without its `_total`; its samples carry it.
    const base = f.type === "counter" ? f.name.replace(/_total$/, "") : f.name;
    if (!base) throw new Error(`invalid metric name: ${f.name}`);
    if (seen.has(base)) throw new Error(`duplicate family: ${base}`);
    seen.add(base);
    for (const suffix of SUFFIXES[f.type]) {
      if (sampleNames.has(base + suffix)) throw new Error(`sample name collision: ${base}${suffix}`);
      sampleNames.add(base + suffix);
    }
    out.push(`# TYPE ${base} ${f.type}`);
    if (f.help) out.push(`# HELP ${base} ${escapeHelp(f.help)}`);
    const keys = new Set<string>();
    for (const s of f.samples as (Sample | HistogramSample)[]) {
      const key = labelSet(s.labels);
      if (keys.has(key)) throw new Error(`duplicate series in ${base}: ${base}${key}`);
      keys.add(key);
      if (f.type === "histogram") histogramLines(base, s as HistogramSample, out);
      else if (f.type === "counter") {
        checkCount((s as Sample).value, `${base} counter value`);
        out.push(`${base}_total${key} ${formatNumber((s as Sample).value)}`);
      } else out.push(`${base}${key} ${formatNumber((s as Sample).value)}`);
    }
  }
  out.push("# EOF");
  return out.join("\n") + "\n";
}
