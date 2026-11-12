/**
 * The file renderers that draw text a stranger pushed, fed a generator's
 * cases: valid files of each kind spliced with markup, `javascript:` URLs,
 * NUL, lone surrogates and very long lines. Every case must render without
 * throwing, and the HTML it gives must carry no `<script`, no `on…=` event
 * attribute and no `href`/`src`/`action` that runs `javascript:`. Seeded
 * (`FUZZ_SEED`, `FUZZ_RUNS`): a failure prints the seed and the shrunk case,
 * to be kept in test/fuzz-found.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { Renderer } from "../src/web/render/renderers.ts";
import { csv } from "../src/web/render/csv.ts";
import { log } from "../src/web/render/log.ts";
import { ics } from "../src/web/render/ics.ts";
import { eml } from "../src/web/render/eml.ts";
import { vcf } from "../src/web/render/vcf.ts";
import { gpx } from "../src/web/render/gpx.ts";
import { geojson } from "../src/web/render/geojson.ts";
import { subtitles } from "../src/web/render/subtitles.ts";
import { patch } from "../src/web/render/patch.ts";
import { notebook } from "../src/web/render/notebook.ts";
import { makefile } from "../src/web/render/makefile.ts";
import { lcov } from "../src/web/render/lcov.ts";
import { sarif } from "../src/web/render/sarif.ts";
import { gcode } from "../src/web/render/gcode.ts";
import { config } from "../src/web/render/config.ts";
import { markdown } from "../src/web/render/markdown.ts";
import { fuzz, int, mix, pick, type Rand } from "./helpers/fuzz.ts";

/** What a hostile file tries to smuggle into the page. */
export const HOSTILE = [
  "<script>alert(1)</script>",
  "<ScRiPt src=//x.test/a.js>",
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  "javascript:alert(1)",
  " JaVaScRiPt:alert(1)",
  "[x](javascript:alert(1))",
  "![x](javascript:alert(1))",
  "<a href=\"javascript:alert(1)\">x</a>",
  "<iframe src=javascript:alert(1)>",
  "\u0000",
  "\ud800",
  "\udfff",
  "\u001b[31m",
  "\u001b]8;;javascript:alert(1)\u0007x\u001b]8;;\u0007",
  "&lt;script&gt;",
  "\r\n",
  "\n",
  "\t",
  ",",
  '"',
  "'",
  "<",
  ">",
  "&",
  "x".repeat(5000),
];

/** A valid file of each kind; a case is one of these with hostile text spliced in. */
const SAMPLES: Record<string, { path: string; render: Renderer; files: readonly string[] }> = {
  csv: {
    path: "data.csv",
    render: csv,
    files: ['name,url,note\nAda,https://a.test,"quoted, cell"\nBob,javascript:alert(1),x\n'],
  },
  tsv: { path: "data.tsv", render: csv, files: ["a\tb\tc\n1\t2\t3\n"] },
  jsonl: {
    path: "rows.jsonl",
    render: csv,
    files: ['{"a":1,"b":"<b>x</b>"}\n{"a":2,"href":"javascript:alert(1)"}\n'],
  },
  log: {
    path: "build.log",
    render: log,
    files: [
      "\u001b[1;32mok\u001b[0m step one\n\u001b[38;5;196mfail\u001b[0m\n\u001b]8;;https://a.test\u0007link\u001b]8;;\u0007\n",
    ],
  },
  ics: {
    path: "cal.ics",
    render: ics,
    files: [
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Meet\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\nLOCATION:Room 1\r\nURL:https://a.test/\r\nDESCRIPTION:Line\\nTwo\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    ],
  },
  vcf: {
    path: "people.vcf",
    render: vcf,
    files: [
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Lovelace\r\nEMAIL:ada@a.test\r\nTEL:+1 555\r\nURL:https://a.test/\r\nORG:Engines\r\nNOTE:hi\r\nEND:VCARD\r\n",
    ],
  },
  eml: {
    path: "mail.eml",
    render: eml,
    files: [
      "From: Ada <a@a.test>\r\nSubject: =?utf-8?Q?<script>?=\r\nMIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<p onclick=x>hi</p>\r\n",
    ],
  },
  gpx: {
    path: "track.gpx",
    render: gpx,
    files: [
      '<?xml version="1.0"?><gpx version="1.1" creator="x"><metadata><name>Walk</name><link href="https://a.test"/></metadata><trk><name>T</name><trkseg><trkpt lat="51.5" lon="-0.1"><ele>10</ele><time>2026-01-01T10:00:00Z</time></trkpt><trkpt lat="51.6" lon="-0.2"><ele>12</ele></trkpt></trkseg></trk><wpt lat="51.5" lon="-0.1"><name>W</name><desc>d</desc></wpt></gpx>',
    ],
  },
  geojson: {
    path: "map.geojson",
    render: geojson,
    files: [
      '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"A","url":"javascript:alert(1)"},"geometry":{"type":"Point","coordinates":[0.1,51.5]}},{"type":"Feature","properties":{"k":"v"},"geometry":{"type":"LineString","coordinates":[[0,0],[1,1]]}}]}',
    ],
  },
  sarif: {
    path: "scan.sarif",
    render: sarif,
    files: ['{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"T"}},"results":[{"ruleId":"R","level":"error","message":{"text":"m"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/a.ts"},"region":{"startLine":3}}}]}]}]}'],
  },
  lcov: {
    path: "lcov.info",
    render: lcov,
    files: ["TN:\nSF:src/a.ts\nFNF:2\nFNH:1\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nBRF:4\nBRH:2\nend_of_record\n"],
  },
  makefile: {
    path: "Makefile",
    render: makefile,
    files: [".PHONY: all clean\nCC := <b>gcc</b>\nall: a.o | dir\n\t$(CC) -o x \\\n\t  a.o\nclean:\n\trm -f *.o\ninclude <script>.mk\n"],
  },
  srt: {
    path: "talk.srt",
    render: subtitles,
    files: ["1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i> there\n\n2\n00:00:03,000 --> 00:00:04,500\n<b>Bye</b>\n"],
  },
  vtt: {
    path: "talk.vtt",
    render: subtitles,
    files: ["WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ada>Hello <c.x>there</c>\n\nNOTE x\n\n00:00:03.000 --> 00:00:04.000 align:start\nBye\n"],
  },
  patch: {
    path: "fix.patch",
    render: patch,
    files: [
      "From abc Mon Sep 17 00:00:00 2001\nFrom: Ada <ada@a.test>\nSubject: [PATCH] fix\n\n---\ndiff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n",
    ],
  },
  notebook: {
    path: "nb.ipynb",
    render: notebook,
    files: [
      '{"nbformat":4,"nbformat_minor":5,"metadata":{"kernelspec":{"name":"python3","language":"python"}},"cells":[{"cell_type":"markdown","source":["# Title\\n","[x](https://a.test)"]},{"cell_type":"code","execution_count":1,"source":"print(1)","outputs":[{"output_type":"stream","name":"stdout","text":["1\\n"]},{"output_type":"execute_result","data":{"text/html":["<b>x</b>"],"text/plain":["x"],"image/png":"iVBORw0KGgo="}},{"output_type":"error","ename":"E","evalue":"v","traceback":["\\u001b[31mE\\u001b[0m"]}]}]}',
    ],
  },
  gcode: {
    path: "part.gcode",
    render: gcode,
    files: [";FLAVOR:Marlin\n;LAYER:0\nG28\nG1 Z0.2 F300\nG1 X10 Y10 E1 F1200\nG1 X20 Y10 E2\n;LAYER:1\nG1 Z0.4\nG1 X20 Y20 E3\nM104 S200 ; <b>hot</b>\n"],
  },
  json: {
    path: "settings.json",
    render: config,
    files: ['{"name":"x","port":8080,"debug":true,"tags":["a","b"],"nested":{"url":"javascript:alert(1)","n":null}}'],
  },
  yaml: {
    path: "settings.yaml",
    render: config,
    files: ["name: x\nport: 8080\ntags:\n  - a\n  - b\nnested:\n  url: \"javascript:alert(1)\"\n"],
  },
  toml: {
    path: "settings.toml",
    render: config,
    files: ['name = "x"\nport = 8080\n[nested]\nurl = "javascript:alert(1)"\n'],
  },
  markdown: {
    path: "docs/README.md",
    render: markdown,
    files: [
      "# Title\n\nSome *text* and a [link](https://a.test) and ![img](pic.png).\n\n```js\ncode()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<details><summary>x</summary>y</details>\n",
    ],
  },
};

/** One case: a sample cut at random places with hostile pieces put in. */
const caseFor =
  (files: readonly string[]) =>
  (r: Rand): string => {
    let text = pick(r, files);
    if (r() < 0.1) return mix(r, HOSTILE, 20);
    for (let n = int(r, 6) + 1; n > 0; n--) {
      const at = int(r, text.length + 1);
      const cut = r() < 0.2 ? int(r, 8) : 0;
      text = text.slice(0, at) + mix(r, HOSTILE, 3) + text.slice(at + cut);
    }
    return text;
  };

/** Each tag's attributes as [name, value], read the way a browser reads them. */
export function attributes(html: string): [string, string][] {
  const out: [string, string][] = [];
  for (const tag of html.matchAll(/<[a-zA-Z][^\s/>]*([^>]*)>/g)) {
    const rest = tag[1] ?? "";
    for (const a of rest.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g))
      out.push([a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""]);
  }
  return out;
}

const decodeEntities = (v: string): string =>
  v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;|&newline;/gi, "")
    .replace(/&amp;/g, "&");

/** Throws when rendered HTML would run script in a reader's browser. */
export function assertInert(html: string): void {
  if (/<script/i.test(html)) throw new Error("raw <script in output");
  for (const [name, value] of attributes(html)) {
    if (/^on[a-z]+$/.test(name)) throw new Error(`event attribute ${name}= in output`);
    if (/^(href|src|action|formaction|xlink:href|poster|data)$/.test(name)) {
      const url = decodeEntities(value).replace(/[\u0000- ]/g, "").toLowerCase();
      if (url.startsWith("javascript:") || url.startsWith("vbscript:"))
        throw new Error(`${name}="${value}" runs script`);
    }
  }
}

const encoder = new TextEncoder();

describe("fuzz: file renderers", () => {
  test("the inertness check catches what it is for", () => {
    expect(() => assertInert("<script>x</script>")).toThrow();
    expect(() => assertInert('<img src=x onerror="a()">')).toThrow();
    expect(() => assertInert("<a href=' javascript:a()'>x</a>")).toThrow();
    expect(() => assertInert('<a href="java&#x73;cript:a()">x</a>')).toThrow();
    expect(() => assertInert("<p>&lt;img onerror=a()&gt; javascript:a()</p>")).not.toThrow();
    expect(() => assertInert('<a title="x onerror=y" href="https://a.test">x</a>')).not.toThrow();
  });

  test("a renderer that forgets to escape is caught, with its seed", async () => {
    const leaky = (text: string) => assertInert(`<pre>${text}</pre>`);
    await expect(fuzz("renderer leaky", caseFor(SAMPLES["csv"]!.files), leaky, 100)).rejects.toThrow(
      /FUZZ_SEED=\d+ case \d+\n {2}minimal: /,
    );
  });

  for (const [name, sample] of Object.entries(SAMPLES))
    test(`${name}: never throws, never lets a tag or a javascript: URL through`, async () => {
      // The valid sample itself draws, so the cases built on it reach the drawing.
      for (const file of sample.files) {
        const out = sample.render(input(sample.path, file));
        expect(out.content.text.length).toBeGreaterThan(0);
      }
      await fuzz(
        `renderer ${name}`,
        caseFor(sample.files),
        (text) => {
          const all = text.length % 2 === 0;
          const out = sample.render(input(sample.path, text, all));
          assertInert(out.content.text);
        },
        Math.min(Number(process.env["FUZZ_RUNS"] ?? 250), 250),
      );
    });
});

function input(path: string, text: string, all = false) {
  const body = encoder.encode(text);
  return {
    path,
    size: body.length,
    body,
    media: `/o/r/media/main/${path}`,
    download: `/o/r/media/main/${path}?download=1`,
    pathHref: `/o/r/blob/main/${path}`,
    repo: { base: "/o/r", ref: "main" },
    all,
    table: "<script>",
    layer: 2,
  };
}
