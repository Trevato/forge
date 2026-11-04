/**
 * The milestones page fits a 390 px phone (#9326): seeded with a 250-character
 * unbroken word, a long title and many rows, neither the top page nor an
 * opened milestone fixes a width over 390 px, and long words wrap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_MILESTONES_PAGE, ownerLooksFor } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const TITLE_WORD = "T".repeat(250);
let dir: string;
let app: App;
let servers: Servers;
let top: string;
let opened: string;
let session: { name: string; value: string };
let openedPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-ms-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const cookie = ((await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const alice = getUserByName(app.db, "alice")!;
  const r = await createRepo(app, alice, { name: "fit", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const mk = (title: string) => {
    const o = openIssue(app, alice, r.value, { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const link = (a: ReturnType<typeof mk>, b: ReturnType<typeof mk>) => {
    const l = linkIssue(app, alice, r.value, a, b);
    if (!l.ok) throw new Error(String(l.error));
  };
  // Many top-level limbs, each waiting on a leaf; the first has many leaves.
  const roots = Array.from({ length: 30 }, (_, n) => mk(n === 0 ? TITLE_WORD : n === 1 ? "A long and winding milestone title ".repeat(7) : `Limb ${n} ${TITLE_WORD.slice(0, 200)}`));
  for (const [n, root] of roots.entries()) link(root, mk(`Leaf ${n}`));
  for (let n = 0; n < 25; n++) link(roots[0]!, mk(`Leaf ${n} ${TITLE_WORD.slice(0, 200)}`));
  const get = async (path: string) => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
  session = { name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1) };
  openedPath = `/alice/fit/milestones/${roots[0]!.number}`;
  top = await get("/alice/fit/milestones");
  opened = await get(openedPath);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the milestones pages at 390 px", () => {
  test("both pages render the seeded long content", () => {
    expect(top).toContain(TITLE_WORD);
    expect(top.match(/<li/g)!.length).toBeGreaterThan(5);
    expect(opened).toContain(TITLE_WORD);
    expect(opened).toContain("data-milestone");
    expect(top).toContain("setting-list");
    expect(top).toMatch(/<div data-milestone>/);
    expect(opened).toMatch(/<div data-milestone>/);
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    for (const page of [top, opened]) {
      expect(page).not.toMatch(/style="[^"]*(?:^|[;\s"])(?:min-)?width\s*:/i);
      for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
      const over: string[] = [];
      for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
        for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
          const px = Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16);
          if (px > 390) over.push(m[0]);
        }
      }
      expect(over).toEqual([]);
    }
  });

  test("every list of rows on both pages wraps: none truncates a long title past the edge", () => {
    for (const page of [top, opened]) {
      const lists = [...page.matchAll(/<ul class="(list[^"]*)"/g)].map((m) => m[1]);
      expect(lists.length).toBeGreaterThan(0);
      for (const cls of lists) expect(cls).toBe("list setting-list");
    }
  });

  test("long-text containers wrap anywhere", () => {
    // The rule selects the attribute the pages render, and sets the wrap.
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-milestone\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|,)\s*\[data-milestone\]\s*(?:,|$)/);
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    expect(components).toMatch(/\.setting-list \.row-title[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

test("a forge preview takes the owner's milestones page at desk and phone (#9326)", () => {
  const looks = ownerLooksFor("trevato/forge", { ownerName: "trevato", name: "forge" }, "preview");
  expect(PREVIEW_MILESTONES_PAGE).toBe("/preview-admin/sample/milestones");
  for (const kind of ["desktop", "phone"] as const) expect(looks).toContainEqual({ page: PREVIEW_MILESTONES_PAGE, kind });
});

/**
 * Measured, not read from the CSS: both pages, with the 250-character
 * unbroken title, in a real Chromium at 390x844 do not scroll sideways, and
 * no milestone row is taller than the screen. Skipped where no Chromium
 * starts; the forge's check runs it and logs the numbers.
 */
const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the milestones phone look is not measured");

describe.skipIf(chromium === undefined)("the milestones pages, measured at 390x844", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const scope = [...document.querySelectorAll("[data-milestone], [data-milestone] *")];
    const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
    const rows = [...document.querySelectorAll("[data-milestone] li")].map((li) => Math.round(li.getBoundingClientRect().height));
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, wrapped: scope.length > 0, overflowing, tallest: Math.max(0, ...rows), rows: rows.length });
  })()`;
  type Measured = { scrollWidth: number; viewportWidth: number; wrapped: boolean; overflowing: string[]; tallest: number; rows: number };

  for (const which of ["list", "opened"] as const) {
    test(`${which}: no sideways scroll, no row taller than the screen`, async () => {
      const path = which === "list" ? "/alice/fit/milestones" : openedPath;
      const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${path}`, { width: 390, height: 844 }, [session], measure)) as Measured;
      console.log(`milestones ${which} 390x844: ${JSON.stringify(m)}`);
      expect(m.wrapped).toBe(true);
      expect(m.rows).toBeGreaterThan(5);
      expect(m.overflowing).toEqual([]);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
      expect(m.tallest).toBeLessThanOrEqual(844);
    }, 30_000);
  }
});
