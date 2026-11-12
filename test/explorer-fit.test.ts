/**
 * The /explore page fits a 390 px phone (#9370): seeded with a 250-character
 * unbroken word in a description, a long name and many rows, it fixes no
 * width over 390 px, long text wraps, and nothing scrolls sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "W".repeat(250);
const PATHS = ["/explore", "/explore?q=kind:person", "/explore?q=" + encodeURIComponent(`${WORD} nothing`)];
let dir: string;
let app: App;
let servers: Servers;
let pages: string[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-explore-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  proveAll(app);
  promote(app.db, made.value);
  for (let n = 0; n < 25; n++) {
    const name = n === 0 ? "n".repeat(60) : `app-${n}`;
    const r = await createRepo(app, made.value, { name, visibility: "public", description: n < 3 ? `${WORD} ${n}` : `An app, number ${n}, with a fairly long description that goes on`.repeat(3) });
    if (!r.ok) throw new Error(String(r.error));
    const rec = insertApp(app.db, { repoId: r.value.id, slug: `alice-${n}`, access: "public" });
    if (!rec.ok) throw new Error(rec.error);
  }
  pages = await Promise.all(PATHS.map(async (p) => (await fetch(`${servers.url}${p}`)).text()));
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("/explore at 390 px", () => {
  test("renders the seeded long content, many rows", () => {
    expect(pages[0]).toContain(WORD);
    expect(pages[0]!.match(/<li/g)!.length).toBeGreaterThan(20);
    expect(pages[0]).toContain("data-explore");
    expect(pages[2]).toContain("data-explore");
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    for (const page of pages) {
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

  test("long-text containers wrap anywhere, and rows wrap instead of truncating", () => {
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-explore\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|,)\s*\[data-explore\]\s*(?:,|$)/);
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    expect(content).toMatch(/\[data-explore\] \.row-title[^{]*\{[^}]*white-space:\s*normal/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the explore phone look is not measured");

describe.skipIf(chromium === undefined)("/explore, measured at 390x844", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const scope = [...document.querySelectorAll("[data-explore], [data-explore] *")];
    const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, wrapped: scope.length > 0, overflowing });
  })()`;
  for (const path of PATHS) {
    test(`${path.slice(0, 40)}: no sideways scroll`, async () => {
      const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${path}`, { width: 390, height: 844 }, [], measure)) as { scrollWidth: number; viewportWidth: number; wrapped: boolean; overflowing: string[] };
      console.log(`explore ${path.slice(0, 40)} 390x844: ${JSON.stringify(m)}`);
      expect(m.wrapped).toBe(true);
      expect(m.overflowing).toEqual([]);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
    }, 30_000);
  }
});

describe("/explore speaks the home page's language (#9645)", () => {
  test("kinds are tabs, rows sit on a bare card, filters and Make it yours remain", () => {
    expect(pages[0]).toContain('<nav class="tabs"');
    expect(pages[0]).toMatch(/class="card bare"/);
    expect(pages[0]).not.toMatch(/class="card"/);
    expect(pages[0]).toContain("Show archived");
    expect(pages[0]).toContain("make-it-yours");
  });
});
