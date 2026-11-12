/**
 * The home's KPI row at phone width (#6067). The row is `.stats` (an
 * auto-fit grid) plus `.kpi-row`; at 360px (328px of content) two 160px
 * tiles and the gap need 332px, so the grid alone falls to one column and
 * nine tiles stack to ~1,100px. This lays the real tiles and the real
 * stylesheet out in headless Chromium, inside a 360px iframe so the media
 * query sees a phone, and counts the columns the browser actually made.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "../src/looks/capture.ts";
import { kpiRowFor } from "../src/web/studio/kpi_row.ts";
import { components } from "../src/web/style/components.ts";
import type { Kpis } from "../src/flow/kpis.ts";
import { chromiumRuns } from "./helpers/chrome.ts";

const k = {
  landedHours: Array(24).fill(0), landed: 0, live: null, medianCheckMs: null,
  builders: { running: 1, slots: 2 }, spend: { todayUsd: 123456.78, ceilingUsd: null }, backupAt: null,
  reach: { visitorDays: [1, 2], loadP75: null },
} as unknown as Kpis;

const tiles = kpiRowFor(k, null).toString();

test("a six-digit value renders inside a tile of the row", () => {
  expect(tiles).toContain('class="stats kpi-row mb"');
  expect(tiles).toMatch(/<span class="stat-value num"[^>]*>\$123457<\/span>/);
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;

/** The distinct x offsets of the tiles' left edges in a frame `width` wide. */
function columnsAt(bin: string, width: number): number {
  const dir = mkdtempSync(join(tmpdir(), "forge-kpi-"));
  try {
    const inner = `<!doctype html><meta name=viewport content="width=device-width"><style>
:root{--border:#ccc;--card:#fff;--fg:#000;--radius:6px;--muted-fg:#666;--fs-min:12px;--attn:red}
body{margin:16px}${components}</style>${tiles}`;
    const page = `<!doctype html><body><iframe id=f width=${width} height=900 style="border:0" srcdoc="${inner
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe><pre id=out></pre><script>
document.getElementById("f").onload=function(){var d=this.contentDocument;
var xs=new Set([].map.call(d.querySelectorAll(".kpi-row > .stat"),function(e){return Math.round(e.getBoundingClientRect().left)}));
document.getElementById("out").textContent="COLS="+xs.size+" N="+d.querySelectorAll(".kpi-row > .stat").length}</script>`;
    const file = join(dir, "p.html");
    writeFileSync(file, page);
    const run = Bun.spawnSync(
      [bin, "--headless", "--no-sandbox", "--disable-gpu", `--user-data-dir=${dir}/u`,
        "--virtual-time-budget=3000", "--dump-dom", `file://${file}`],
      { stdout: "pipe", stderr: "ignore", timeout: 20000 },
    );
    const m = /COLS=(\d+) N=(\d+)/.exec(run.stdout.toString());
    if (m === null) throw new Error("no measurement: " + run.stdout.toString().slice(0, 300));
    expect(Number(m[2])).toBeGreaterThan(2);
    return Number(m[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(chromium === undefined)("at 360px the tiles sit two to a line; at 1000px more", () => {
  expect(columnsAt(chromium!, 360)).toBe(2);
  expect(columnsAt(chromium!, 1000)).toBeGreaterThan(2);
});

test("below 480px the row is two equal columns that may shrink to fit 328px", () => {
  const m = /@media \(max-width: 480px\) \{ \.kpi-row \{ grid-template-columns: repeat\((\d+), minmax\(0, 1fr\)\); \} \}/.exec(components);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBe(2);
  // minmax(0, …) has no floor, so nothing forces the 332px the 160px basis needed.
});
