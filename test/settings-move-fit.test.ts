/**
 * Settings › Move to another owner fits a 390 px phone (#10320). Three holds:
 * the refused state (a 64-character unknown owner and its refusal sentence) is
 * rendered inside the #move section; the stylesheet rules that lay out the
 * field, its error and the actions row fix no width over 390 px and forbid no
 * wrapping (rules inside @media/@supports/@container blocks included); and,
 * where a Chromium runs, the page is measured at 390x844 both as served and
 * with the refused section swapped in.
 *
 * Limit: the stylesheet holds read the source text of base, components and
 * content, not computed layout; the Chromium measurement is what catches an
 * overflow, and it is skipped where no Chromium starts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { adminCookie } from "./helpers/admin.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const LONG = "o".repeat(64);
let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
let refused: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-move-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "settings-password" });
  await fetch(`${servers.url}/new`, {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ name: "proj", visibility: "private", description: "x" }),
    redirect: "manual",
  });
  const res = await fetch(`${servers.url}/olive/proj/settings/transfer`, {
    method: "POST",
    headers: { cookie, origin: servers.url },
    body: new URLSearchParams({ owner: LONG }),
    redirect: "manual",
  });
  expect(res.status).toBe(422);
  refused = await res.text();
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

function moveSection(page: string): string {
  const from = page.indexOf('id="move"');
  expect(from).toBeGreaterThan(-1);
  return page.slice(from, page.indexOf("</section>", from));
}

describe("Move to another owner, refused", () => {
  test("the long owner and its refusal sentence render inside the section", () => {
    const section = moveSection(refused);
    expect(section).toContain(`value="${LONG}"`);
    expect(section).toMatch(/class="error"[^>]*>[^<]+/);
    expect(section).not.toMatch(/\b(?:min-)?width\s*[:=]|nowrap|white-space|\bsize="/i);
  });
});

/**
 * Every `selector { body }` in `css`, with conditional group rules unwrapped
 * first so a rule inside `@media (…) { … }` is read like a top-level one; the
 * group's closing brace is left behind as a separator.
 */
function rules(css: string): { selector: string; body: string }[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(?:media|supports|container|layer)[^{;]*\{/g, "");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

describe("the rules that lay the section out", () => {
  const css = [base, components, content].join("\n");
  const rulesFor = (sel: RegExp, from = css) => rules(from).filter((r) => sel.test(r.selector)).map((r) => r.body);
  const selectors = /(?:^|[\s,])(?:\.field\b|\.input\b|\.form-actions\b|\.settings-block\b|\.muted\b)/;

  test("they exist", () => {
    expect(rulesFor(selectors).length).toBeGreaterThan(5);
    expect(rulesFor(/\.form-actions\s*$/).join("")).toContain("flex-wrap: wrap");
    expect(rulesFor(/\.field .error/).join("")).toContain("overflow-wrap: anywhere");
  });

  test("a rule inside a media block is read", () => {
    const nested = "@media (max-width: 600px) {\n  .x { color: red; }\n  .field .input { width: 480px; }\n}\n.y { margin: 0; }";
    expect(rulesFor(selectors, nested)).toEqual([" width: 480px; "]);
    expect(rulesFor(/\.y$/, nested)).toEqual([" margin: 0; "]);
  });

  test("none fixes a width over 390 px or forbids wrapping", () => {
    const over: string[] = [];
    for (const body of rulesFor(selectors)) {
      expect(body).not.toMatch(/white-space:\s*(?:nowrap|pre)\b/);
      for (const m of body.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        const px = Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16);
        if (px > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the Move phone look is not measured");

describe.skipIf(chromium === undefined)("Settings › Move, measured at 390x844", () => {
  const measureWith = (section: string | null) => `(() => {
    const swap = ${JSON.stringify(section)};
    const el = document.getElementById("move");
    if (swap !== null && el) el.outerHTML = swap;
    const move = document.getElementById("move");
    const vw = window.innerWidth;
    const scope = move ? [move, ...move.querySelectorAll("*")] : [];
    const overflowing = scope.filter((e) => e.getBoundingClientRect().right > vw + 1).map((e) => e.tagName.toLowerCase());
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, innerWidth: vw, scoped: scope.length, error: !!move?.querySelector(".error"), overflowing });
  })()`;
  const run = async (label: string, section: string | null) => {
    const name = cookie.slice(0, cookie.indexOf("="));
    const session = { name, value: cookie.slice(name.length + 1) };
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/olive/proj/settings#move`, { width: 390, height: 844 }, [session], measureWith(section))) as { scrollWidth: number; innerWidth: number; scoped: number; error: boolean; overflowing: string[] };
    console.log(`settings#move ${label} 390x844: ${JSON.stringify(m)}`);
    expect(m.scoped).toBeGreaterThan(0);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
    return m;
  };
  test("as served, no sideways scroll", async () => {
    await run("served", null);
  }, 30_000);
  test("refused with a 64-character owner, no sideways scroll", async () => {
    const section = refused.slice(refused.lastIndexOf("<section", refused.indexOf('id="move"')), refused.indexOf("</section>", refused.indexOf('id="move"')) + "</section>".length);
    expect(section.startsWith('<section class="settings-block" id="move"')).toBe(true);
    const m = await run("refused", section);
    expect(m.error).toBe(true);
  }, 30_000);
});
