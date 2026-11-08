/**
 * The /apps page fits a 390 px phone (#9371): seeded with long names, a
 * 250-character unbroken description and many rows, it fixes no width over
 * 390 px, its containers wrap anywhere, and (where a Chromium starts) it does
 * not scroll sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "W".repeat(250);
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let session: { name: string; value: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-apps-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const cookie = ((await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const alice = getUserByName(app.db, "alice")!;
  for (let n = 0; n < 25; n++) {
    const name = n === 0 ? "n".repeat(60) : `app-${n}-${"x".repeat(40)}`;
    const r = await createRepo(app, alice, { name, visibility: "public", description: n < 3 ? WORD : "A long and winding description of an app ".repeat(5) });
    if (!r.ok) throw new Error(String(r.error));
    const rec = makeAppRecord(app.db, { repoId: r.value.id, slug: `a${n}`, access: "public" });
    if (!rec.ok) throw new Error(String(rec.error));
  }
  session = { name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1) };
  page = await (await fetch(`${servers.url}/apps`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the /apps page at 390 px", () => {
  test("renders the seeded long content as many rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("data-apps-page");
    expect(page.match(/class="row"/g)!.length).toBeGreaterThan(20);
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
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
  });

  test("the list of rows wraps, and the page's container wraps anywhere", () => {
    expect(page).toContain('<ul class="list setting-list">');
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-apps-page\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    expect(components).toMatch(/\.setting-list \.row-title[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the /apps phone look is not measured");

describe.skipIf(chromium === undefined)("the /apps page, measured at 390x844", () => {
  test("no sideways scroll", async () => {
    const measure = `(() => {
      const vw = document.documentElement.clientWidth;
      const scope = [...document.querySelectorAll("[data-apps-page], [data-apps-page] *")];
      const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
      return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, wrapped: scope.length > 0, overflowing });
    })()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/apps`, { width: 390, height: 844 }, [session], measure)) as { scrollWidth: number; viewportWidth: number; wrapped: boolean; overflowing: string[] };
    console.log(`apps 390x844: ${JSON.stringify(m)}`);
    expect(m.wrapped).toBe(true);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
