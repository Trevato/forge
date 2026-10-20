/** The OpenMetrics writer, checked by a strict parser written here. */

import { describe, expect, test } from "bun:test";
import { openMetrics, type Family, type HistogramSample } from "../src/metrics/openmetrics.ts";

type Parsed = { type: string; help?: string; samples: { name: string; labels: Record<string, string>; value: number }[] };

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)$/;

function parseLabels(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < src.length) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)="/.exec(src.slice(i));
    if (!m) throw new Error(`bad label at ${src.slice(i)}`);
    i += m[0].length;
    let v = "";
    for (;;) {
      const c = src[i++];
      if (c === undefined) throw new Error("unterminated label value");
      if (c === '"') break;
      if (c === "\n") throw new Error("raw newline in label");
      if (c === "\\") {
        const e = src[i++];
        if (e === "n") v += "\n";
        else if (e === "\\" || e === '"') v += e;
        else throw new Error("bad escape");
      } else v += c;
    }
    out[m[1]!] = v;
    if (i < src.length) {
      if (src[i++] !== ",") throw new Error("labels must be comma separated");
    }
  }
  return out;
}

function num(s: string): number {
  if (s === "+Inf") return Infinity;
  if (s === "-Inf") return -Infinity;
  if (s === "NaN") return NaN;
  if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) throw new Error(`bad number ${s}`);
  return Number(s);
}

function parse(text: string): Map<string, Parsed> {
  if (!text.endsWith("# EOF\n")) throw new Error("missing # EOF");
  const lines = text.slice(0, -1).split("\n");
  lines.pop();
  const fams = new Map<string, Parsed>();
  let cur: Parsed | undefined;
  let curName = "";
  for (const line of lines) {
    let m = /^# TYPE (\S+) (counter|gauge|histogram)$/.exec(line);
    if (m) {
      if (fams.has(m[1]!)) throw new Error(`duplicate family ${m[1]}`);
      cur = { type: m[2]!, samples: [] };
      curName = m[1]!;
      fams.set(curName, cur);
      continue;
    }
    m = /^# HELP (\S+) (.*)$/.exec(line);
    if (m) {
      if (!cur || m[1] !== curName) throw new Error("HELP outside its family");
      cur.help = m[2]!;
      continue;
    }
    if (line.startsWith("#") || line === "") throw new Error(`unexpected line: ${line}`);
    m = SAMPLE.exec(line);
    if (!m || !cur) throw new Error(`bad sample: ${line}`);
    const name = m[1]!;
    const suffixes = cur.type === "counter" ? ["_total"] : cur.type === "histogram" ? ["_bucket", "_count", "_sum"] : [""];
    if (!suffixes.some((s) => name === curName + s)) throw new Error(`sample ${name} not in family ${curName}`);
    cur.samples.push({ name, labels: parseLabels(m[3] ?? ""), value: num(m[4]!) });
  }
  for (const [name, f] of fams) {
    if (f.type !== "histogram") continue;
    const groups = new Map<string, number[]>();
    const ends = new Set<string>();
    for (const s of f.samples.filter((x) => x.name === `${name}_bucket`)) {
      const { le, ...rest } = s.labels;
      if (le === undefined) throw new Error("bucket without le");
      const key = JSON.stringify(rest);
      const prev = groups.get(key) ?? [];
      if (ends.has(key)) throw new Error("bucket after +Inf");
      if (prev.length && s.value < prev[prev.length - 1]!) throw new Error("non-cumulative bucket");
      prev.push(s.value);
      groups.set(key, prev);
      if (le === "+Inf") ends.add(key);
    }
    for (const key of groups.keys()) if (!ends.has(key)) throw new Error("histogram without +Inf bucket");
  }
  return fams;
}

describe("parser (guards the guard)", () => {
  test("rejects the malformed", () => {
    expect(() => parse("# TYPE a gauge\na 1\n")).toThrow("EOF");
    expect(() => parse("# TYPE a gauge\n# TYPE a gauge\n# EOF\n")).toThrow("duplicate");
    expect(() => parse('# TYPE a gauge\na{x="q"r"} 1\n# EOF\n')).toThrow();
    expect(() => parse('# TYPE a gauge\na{x="\\q"} 1\n# EOF\n')).toThrow("escape");
    expect(() =>
      parse('# TYPE h histogram\nh_bucket{le="1"} 3\nh_bucket{le="2"} 2\nh_bucket{le="+Inf"} 3\n# EOF\n'),
    ).toThrow("cumulative");
  });
});

const hist: Family = {
  type: "histogram",
  name: "forge_request_seconds",
  help: "Request time.",
  samples: [
    {
      labels: { route: "/" },
      buckets: [
        { le: 0.01, count: 2 },
        { le: 0.1, count: 5 },
      ],
      count: 6,
      sum: 0.75,
    },
  ],
};

const base: HistogramSample = { buckets: [{ le: 1, count: 2 }], count: 2, sum: 1 };
const hist1 = (name: string): Family => ({ type: "histogram", name, help: "", samples: [] });

describe("openMetrics", () => {
  test("writes counter, gauge and histogram families ending in # EOF", () => {
    const text = openMetrics([
      { type: "counter", name: "forge_requests_total", help: "Requests.", samples: [{ labels: { code: "200" }, value: 7 }] },
      { type: "gauge", name: "forge_apps", help: "Apps.", samples: [{ value: 3 }] },
      hist,
    ]);
    expect(text.endsWith("# EOF\n")).toBe(true);
    const f = parse(text);
    expect(f.get("forge_requests")!.type).toBe("counter");
    expect(f.get("forge_requests")!.samples[0]!.name).toBe("forge_requests_total");
    expect(f.get("forge_apps")!.samples[0]!.value).toBe(3);
    expect(f.get("forge_apps")!.help).toBe("Apps.");
    const h = f.get("forge_request_seconds")!;
    expect(h.samples.map((s) => [s.name, s.labels.le, s.value])).toEqual([
      ["forge_request_seconds_bucket", "0.01", 2],
      ["forge_request_seconds_bucket", "0.1", 5],
      ["forge_request_seconds_bucket", "+Inf", 6],
      ["forge_request_seconds_count", undefined, 6],
      ["forge_request_seconds_sum", undefined, 0.75],
    ]);
  });

  test("empty input is just # EOF", () => {
    expect(openMetrics([])).toBe("# EOF\n");
  });

  test("counter names gain _total once", () => {
    const a = openMetrics([{ type: "counter", name: "x", help: "", samples: [{ value: 1 }] }]);
    const b = openMetrics([{ type: "counter", name: "x_total", help: "", samples: [{ value: 1 }] }]);
    expect(a).toBe(b);
    expect(a).toContain("x_total 1\n");
  });

  test("escapes label values and help", () => {
    const nasty = 'a"b\\c\nd';
    const text = openMetrics([{ type: "gauge", name: "g", help: "l1\nl2", samples: [{ labels: { v: nasty }, value: 1 }] }]);
    expect(text).toContain('g{v="a\\"b\\\\c\\nd"} 1');
    const g = parse(text).get("g")!;
    expect(g.samples[0]!.labels.v).toBe(nasty);
    expect(g.help).toBe("l1\\nl2");
  });

  test("names outside the grammar throw", () => {
    for (const name of ["", "1a", "a-b", "a b", "a\n"])
      expect(() => openMetrics([{ type: "gauge", name, help: "", samples: [] }])).toThrow("invalid metric name");
    expect(() => openMetrics([{ type: "gauge", name: "a:b_c", help: "", samples: [] }])).not.toThrow();
    expect(() => openMetrics([{ type: "gauge", name: "g", help: "", samples: [{ labels: { "a-b": "x" }, value: 1 }] }])).toThrow("label");
    expect(() => openMetrics([{ type: "gauge", name: "g", help: "", samples: [{ labels: { __x: "x" }, value: 1 }] }])).toThrow("label");
  });

  test("duplicate families and series throw", () => {
    const g: Family = { type: "gauge", name: "g", help: "", samples: [] };
    expect(() => openMetrics([g, g])).toThrow("duplicate family");
    expect(() => openMetrics([g, { type: "counter", name: "g_total", help: "", samples: [] }])).toThrow("duplicate family");
    expect(() => openMetrics([{ type: "counter", name: "c", help: "", samples: [{ value: 1 }, { value: 2 }] }])).toThrow("duplicate series");
  });

  test("the same labels in another order are the same series", () => {
    const g = (labels: Record<string, string>[]): Family => ({
      type: "gauge",
      name: "g",
      help: "",
      samples: labels.map((l) => ({ labels: l, value: 1 })),
    });
    expect(() => openMetrics([g([{ a: "1", b: "2" }, { b: "2", a: "1" }])])).toThrow("duplicate series");
    expect(openMetrics([g([{ b: "2", a: "1" }])])).toContain('g{a="1",b="2"} 1');
  });

  test("sample names may not collide across families", () => {
    const fam = (type: "counter" | "gauge", name: string): Family => ({ type, name, help: "", samples: [] });
    expect(() => openMetrics([fam("counter", "g"), fam("gauge", "g_total")])).toThrow("collision");
    expect(() => openMetrics([hist1("h"), fam("gauge", "h_count")])).toThrow("collision");
    expect(() => openMetrics([hist1("h"), fam("gauge", "h_bucket")])).toThrow("collision");
    expect(() => openMetrics([hist1("h"), fam("gauge", "h_sum")])).toThrow("collision");
    expect(() => openMetrics([fam("gauge", "h_count"), hist1("h")])).toThrow("collision");
    expect(() => openMetrics([fam("counter", "g"), fam("gauge", "g_other")])).not.toThrow();
  });

  test("an unknown type throws", () => {
    for (const type of ["summary", "", "toString", "__proto__"])
      expect(() => openMetrics([{ type, name: "x", help: "", samples: [] } as unknown as Family])).toThrow("invalid metric type");
  });

  test("histograms must be cumulative, rising and without le label", () => {
    const bad = (s: Partial<HistogramSample>) =>
      openMetrics([{ type: "histogram", name: "h", help: "", samples: [{ ...base, ...s }] }]);
    expect(() => bad({ buckets: [{ le: 1, count: 3 }, { le: 2, count: 2 }] })).toThrow("cumulative");
    expect(() => bad({ buckets: [{ le: 2, count: 1 }, { le: 1, count: 2 }] })).toThrow("rising");
    expect(() => bad({ count: 1 })).toThrow("below");
    expect(() => bad({ labels: { le: "1" } })).toThrow("le");
  });

  test("counters reject negatives; special floats are spelled out", () => {
    expect(() => openMetrics([{ type: "counter", name: "c", help: "", samples: [{ value: -1 }] }])).toThrow();
    expect(openMetrics([{ type: "gauge", name: "g", help: "", samples: [{ value: Infinity }] }])).toContain("g +Inf\n");
  });
});
