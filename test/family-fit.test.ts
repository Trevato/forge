/**
 * The family page fits a 390 px phone (#9375): seeded with a 250-character
 * unbroken forge name and many children, the page fixes no width over 390 px,
 * long words wrap, and a real Chromium does not scroll it sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const WORD = "F".repeat(200);
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let session: { name: string; value: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-family-fit-"));
  app = createApp({ dataDir: dir, port: 0, parentUrl: `https://${"p".repeat(200)}.example.test` });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  await mkdir(join(dir, "spawn"), { recursive: true });
  for (let n = 0; n < 30; n++) {
    const name = `${n}${WORD}`.slice(0, 200);
    await Bun.write(
      join(dir, "spawn", `${name}.json`),
      JSON.stringify({ name, bodyId: `b${n}`, url: `https://${name}.example.test`, planHash: "x", done: true, createdAt: new Date().toISOString() }),
    );
  }
  const cookie = ((await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  session = { name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1) };
  page = await (await fetch(`${servers.url}/family`, { headers: { cookie } })).text();
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the family page at 390 px", () => {
  test("renders the seeded long names and many rows", () => {
    expect(page).toContain(WORD.slice(0, 100));
    expect(page.match(/<li/g)!.length).toBeGreaterThan(20);
    expect(page).toContain("data-family");
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

  test("the tree wraps its long names instead of truncating them", () => {
    expect(page).toContain('class="list setting-list"');
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-family\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|,)\s*\[data-family\]\s*(?:,|$)/);
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    expect(components).toMatch(/\.setting-list \.row-title[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the family phone look is not measured");

describe.skipIf(chromium === undefined)("the family page, measured at 390x844", () => {
  test("no sideways scroll", async () => {
    const measure = `(() => {
      const vw = document.documentElement.clientWidth;
      const scope = [...document.querySelectorAll("[data-family], [data-family] *")];
      const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
      return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, scope: scope.length, overflowing, rows: document.querySelectorAll("[data-family] li").length });
    })()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/family`, { width: 390, height: 844 }, [session], measure)) as { scrollWidth: number; viewportWidth: number; scope: number; overflowing: string[]; rows: number };
    console.log(`family 390x844: ${JSON.stringify(m)}`);
    expect(m.rows).toBeGreaterThan(20);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
