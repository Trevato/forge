/**
 * The owner's /resilience page fits a 390 px phone (#9328): the page as an
 * admin sees it, plus the protection rows rendered with seeded long content
 * (an unbroken 300-character word, a long sentence, many rows), ships no
 * fixed width over 390 px, and the long-text container wraps anywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Row } from "../src/checks/resilience.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { PREVIEW_OWNER_LOOKS, PREVIEW_RESILIENCE_PAGE } from "../src/spawn/preview-looks.ts";
import { protectionsHtml, RESILIENCE_CSS } from "../src/web/pages/resilience.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "R".repeat(300);
const SENTENCE = "A protection said at great length so that it cannot fit one line ".repeat(6).trim();
const ROWS: Row[] = Array.from({ length: 40 }, (_, i) => ({
  p: {
    adversary: i === 2 ? `Adversary ${"a".repeat(120)}` : `Adversary ${i}`,
    text: i === 0 ? WORD : i === 1 ? SENTENCE : `Protection ${i}`,
    test: i === 3 ? `test/${"t".repeat(150)}.test.ts` : i % 2 === 0 ? `test/p${i}.test.ts` : undefined,
  },
  s: (["green", "red", "untested", "no test yet"] as const)[i % 4]!,
}));

let dir: string;
let app: App;
let servers: Servers;
let page: string;
let adminId: string;
const rows = String(protectionsHtml(ROWS));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-resilience-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error("user");
  adminId = u.value.id;
  const cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
  const res = await fetch(`${servers.url}/resilience`, { headers: { cookie } });
  expect(res.status).toBe(200);
  page = await res.text();
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const styles = (html: string): string[] => html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [];

describe("the resilience page at 390 px", () => {
  test("the seeded long content renders, in many rows, escaped", () => {
    expect(rows).toContain(WORD);
    expect(rows).toContain(SENTENCE);
    expect(rows).toContain("t".repeat(150));
    expect(rows.match(/class="row"/g)?.length).toBe(40);
  });

  test("the page draws its rows inside the wrapping container", () => {
    expect(page).toContain("data-resilience");
    expect(page.indexOf("data-resilience")).toBeLessThan(page.indexOf('class="list"'));
    expect(page.match(/data-standing=/g)?.length ?? 0).toBeGreaterThan(5);
  });

  test("no inline width and no shipped rule fixes a width over 390 px", () => {
    for (const html of [page, rows]) {
      expect(html).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
      for (const m of html.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    }
    const over: string[] = [];
    for (const css of [base, components, content, RESILIENCE_CSS, ...styles(page)]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the container wraps anywhere, and a row's title and meta may wrap", () => {
    const css = styles(page).join("\n");
    expect(css).toMatch(/\[data-resilience\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(css).toMatch(/\[data-resilience\] \.row-title[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).toMatch(/\[data-resilience\] \.row-meta[^{]*\{[^}]*white-space:\s*normal/);
  });
});

test("the owner's phone look takes the resilience page", () => {
  expect(PREVIEW_RESILIENCE_PAGE).toBe("/resilience");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_RESILIENCE_PAGE, kind: "phone" });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the resilience page's phone look is not measured");

describe.skipIf(chromium === undefined)("the resilience page, measured", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (getComputedStyle(p).overflowX !== "visible") return true; } return false; };
    const overflowing = [...document.querySelectorAll("[data-resilience], [data-resilience] *")].filter((el) => el.getBoundingClientRect().right > vw + 1 && !clipped(el)).slice(0, 8).map((el) => el.tagName.toLowerCase() + "." + String(el.className));
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, overflowing });
  })()`;
  const look = async (width: number, height: number) => {
    const cookies = [{ name: "forge_session", value: createSession(app.db, adminId).token }];
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${PREVIEW_RESILIENCE_PAGE}`, { width, height }, cookies, measure)) as { scrollWidth: number; viewportWidth: number; overflowing: string[] };
    console.log(`resilience look ${width}x${height}: ${JSON.stringify(m)}`);
    return m;
  };
  test("phone, 390x844: no sideways scroll", async () => {
    const m = await look(390, 844);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
  test("desk, 1280x800: no sideways scroll", async () => {
    const m = await look(1280, 800);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
