/**
 * A proposed bet card is bounded at rest (#9240): the preview seed's proposed
 * bets, rendered as their owner, hold one title, the journeys the page
 * allows, one row of actions, no fixed width, and words that wrap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedPreview } from "../src/spawn/preview-seed.ts";
import { PREVIEW_ADMIN, PREVIEW_BETS_PAGE, PREVIEW_REPO, ownerLooksFor } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { SHOWN_JOURNEYS } from "../src/web/pages/bets.ts";
import { createSession } from "../src/core/sessions.ts";
import { findChromium } from "../src/looks/capture.ts";
import { previewAdmin } from "../src/spawn/preview-seed.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const KEY = "bets-card-fit-key";
let dir: string;
let app: App;
let servers: Servers;
let cards: string[];
let page: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-bets-fit-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
  const said = `u1|trevato|admin|${Date.now() + 60_000}`;
  const headers = { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
  const html = await (await fetch(`${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/bets`, { headers })).text();
  page = html;
  cards = html.split(" data-bet-card=").slice(1).map((c) => c.slice(0, c.indexOf("Cut it") + 40));
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the owner's bets page, a proposed bet card at rest", () => {
  test("the owner sees both proposed bets of the seed as cards", () => {
    expect(cards.length).toBe(2);
    expect(cards.some((c) => c.includes("Price the list"))).toBe(true);
    expect(cards.some((c) => c.includes("Make every long and winding"))).toBe(true);
  });

  test("no box: the list is rows, not cards", () => {
    expect(page).not.toContain('class="card');
    expect(page).toContain("data-bet-card");
  });

  test("one title line", () => {
    for (const c of cards) expect(c.match(/class="row-title"/g)?.length).toBe(1);
  });

  test("at most the journeys the page allows, the rest behind a disclosure", () => {
    for (const c of cards) {
      const [atRest] = c.split("<details>");
      expect(atRest!.match(/<li>/g)?.length ?? 0).toBeLessThanOrEqual(SHOWN_JOURNEYS);
    }
    const long = cards.find((c) => c.includes("Fifth journey"))!;
    expect(long).toContain("2 more journeys");
    expect(long.split("<details>")[0]!.match(/<li>/g)?.length).toBe(SHOWN_JOURNEYS);
  });

  test("one row of actions, holding back, change the share and cut", () => {
    for (const c of cards) {
      expect(c.match(/data-bet-actions/g)?.length).toBe(1);
      const row = c.slice(c.indexOf("data-bet-actions"));
      expect(row).toContain("Back it at 20%");
      expect(row).toContain("Change the share");
      expect(row).toContain("Cut it");
      expect(c.slice(0, c.indexOf("data-bet-actions"))).not.toContain("<form");
    }
    // What keeps the row inside 390 px: .bar is a flex row that wraps.
    expect(base).toMatch(/^\.bar \{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/m);
  });

  test("no element with a fixed width", () => {
    for (const c of cards) {
      expect(c).not.toMatch(/\swidth=/i);
      expect(c).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
    }
    for (const l of base.split("\n").filter((l) => /^\.bar\b/.test(l))) expect(l).not.toMatch(/(?<![-\w])(?:min-|max-)?width\s*:/);
    const rules = content.split("\n").filter((l) => l.includes("[data-bet-card]"));
    for (const r of rules) expect(r).not.toMatch(/(?<![-\w])width\s*:\s*\d/);
  });

  test("a proposed bet's opened disclosures are bounded under one 844 px screen, scrolling inside them and never the row (#9321)", () => {
    expect(content).not.toMatch(/\[data-bet-card\]\s*\{[^}]*max-height/);
    const rule = content.match(/\[data-bet-card\] details ul\s*\{[^}]*max-height:\s*(\d+)(vh|px)[^}]*\}/);
    expect(rule).not.toBeNull();
    const px = rule![2] === "vh" ? (Number(rule![1]) / 100) * 844 : Number(rule![1]);
    expect(px).toBeLessThanOrEqual(844);
    expect(rule![0]).toMatch(/overflow-y:\s*auto/);
  });

  test("long words wrap", () => {
    expect(content).toMatch(/\[data-bet-card\][^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  test("the long proposed bet is on the page, and no rule or element it ships fixes a width over 390 px (#9275)", () => {
    expect(page).toContain("Make every long and winding bet name wrap");
    expect(page).toContain("https://example.com/a/very/long/unbroken/address");
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    // Every stylesheet the layout ships: a width or min-width is a fixed size
    // (max-width is a cap and shrinks; a "(min-width:" media query is a breakpoint, not a size). px, rem/em at 16 px, ch at 8 px.
    const over: string[] = [];
    for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        const px = Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16);
        if (px > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });
});

test("a forge preview takes the owner's bets page at desk and phone (#9275)", () => {
  const looks = ownerLooksFor("trevato/forge", { ownerName: "trevato", name: "forge" }, "preview");
  expect(PREVIEW_BETS_PAGE).toBe("/preview-admin/sample/bets");
  for (const kind of ["desktop", "phone"] as const) expect(looks).toContainEqual({ page: PREVIEW_BETS_PAGE, kind });
});

/**
 * The phone look measured, not read from the CSS (#9321): the owner's bets
 * page in a real Chromium at 390x844 does not scroll sideways, and every
 * proposed card is shorter than the screen with its actions in view at rest.
 * Skipped where no Chromium starts; the forge's check runs it and logs the
 * numbers.
 */
const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the bets phone look is not measured");

describe.skipIf(chromium === undefined)("the owner's bets page, measured at phone and desk", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const cards = [...document.querySelectorAll("[data-bet-card]")].map((c) => {
      const box = c.getBoundingClientRect();
      const body = c.getBoundingClientRect();
      const actions = c.querySelector("[data-bet-actions]").getBoundingClientRect();
      return { height: Math.round(box.height), innerScroll: c.scrollHeight - c.clientHeight, sideways: c.scrollWidth - c.clientWidth, actionsInView: actions.bottom <= body.bottom + 1 };
    });
    // Within the cards: the layout's own chrome (off-canvas, clipped) is web-phone.test.ts's to hold.
    const overflowing = [...document.querySelectorAll("[data-bet-card], [data-bet-card] *")].filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, cards, overflowing });
  })()`;
  type Measured = { scrollWidth: number; viewportWidth: number; overflowing: string[]; cards: { height: number; innerScroll: number; sideways: number; actionsInView: boolean }[] };
  const look = async (width: number, height: number): Promise<Measured> => {
    const admin = previewAdmin(app)!;
    const cookies = [{ name: "forge_session", value: createSession(app.db, admin.id).token }];
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${PREVIEW_BETS_PAGE}`, { width, height }, cookies, measure)) as Measured;
    console.log(`bets look ${width}x${height}: ${JSON.stringify(m)}`);
    return m;
  };

  test("phone, 390x844: no sideways scroll, every proposed card under one screen with its actions in view", async () => {
    const m = await look(390, 844);
    expect(m.cards.length).toBe(2);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
    for (const c of m.cards) {
      expect(c.height).toBeLessThanOrEqual(844);
      expect(c.sideways).toBe(0);
      expect(c.innerScroll).toBe(0);
      expect(c.actionsInView).toBe(true);
    }
  }, 30_000);

  test("desk, 1280x800: no sideways scroll", async () => {
    const m = await look(1280, 800);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
    for (const c of m.cards) expect(c.sideways).toBe(0);
  }, 30_000);
});
