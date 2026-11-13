/**
 * A wide markdown table scrolls sideways in its own frame on a phone; the
 * page never does. The renderer wraps every table in one scroll region, and
 * (where a Chromium starts) a page of tables and code is measured at 390 px.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/web/markdown.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";
import { mdTablePage } from "./helpers/md-table-page.ts";

const md = (s: string): string => String(renderMarkdown(s));

describe("the renderer's table frame", () => {
  test("each table sits in one focusable scroll region", () => {
    const out = md("| a | b |\n| --- | ---: |\n| 1 | 2 |\n\ntext\n\n| c |\n| --- |\n| 3 |");
    expect(out.match(/<div class="table-scroll" role="region" aria-label="Table" tabindex="0"><table>/g)).toHaveLength(2);
    expect(out.match(/<\/table><\/div>/g)).toHaveLength(2);
    expect(out).toContain('<td class="ta-r">2</td>');
  });
  test("a table cut short by the end of the text is still closed", () => {
    expect(md("| a |\n| --- |\n| 1 |")).toMatch(/<\/tbody><\/table><\/div>$/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the markdown table look is not measured");

describe.skipIf(chromium === undefined)("rendered markdown at 390x844", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: (req) => new Response(mdTablePage(new URL(req.url).searchParams.get("t") === "dark" ? "dark" : "light"), { headers: { "content-type": "text/html" } }) });
  });
  afterAll(() => server.stop(true));

  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: the page does not scroll sideways, the wide table does`, async () => {
      const measure = `(() => {
        const t = [...document.querySelectorAll(".table-scroll")].map((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
        const pre = document.querySelector("pre");
        return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth, t, pre: { sw: pre.scrollWidth, cw: pre.clientWidth } });
      })()`;
      const m = JSON.parse(await evaluateLoaded(chromium!, `http://127.0.0.1:${server.port}/?t=${scheme}`, { width: 390, height: 844 }, [], measure, scheme)) as { scrollWidth: number; viewportWidth: number; t: { sw: number; cw: number }[]; pre: { sw: number; cw: number } };
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
      expect(m.t).toHaveLength(5);
      expect(m.t[1]!.sw).toBeGreaterThan(m.t[1]!.cw); // seven columns scroll inside the frame
      expect(m.pre.sw).toBeGreaterThan(m.pre.cw);
    }, 30_000);
  }
});
