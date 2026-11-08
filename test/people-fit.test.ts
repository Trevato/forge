/**
 * Settings › People fits a 390 px phone (#9374): seeded with a 250-character
 * unbroken username, a long one and many rows, the page fixes no width over
 * 390 px, the usernames wrap anywhere, and the table — four columns and a role
 * form — scrolls inside its own box, never the page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const WORD = "U".repeat(250);
const LONG = `bob-${"long-name.".repeat(9)}x`;
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let session: { name: string; value: string };

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-people-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const alice = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true }));
  const names = [LONG, ...Array.from({ length: 24 }, (_, n) => `guest${String(n).padStart(2, "0")}`)];
  for (const [n, username] of names.entries()) {
    must(await createUser(app.db, { origin: "seed", trusted: true, username, email: `p${n}@forge.local`, password: "a-good-passphrase" }));
  }
  // A username caps at 100 characters; an older row may hold more, and the
  // page must still fit, so the longest is written straight to the table.
  const widest = must(await createUser(app.db, { origin: "seed", trusted: true, username: "widest", email: "w@forge.local", password: "a-good-passphrase" }));
  app.db.query("UPDATE user SET username = ?1 WHERE id = ?2").run(WORD, widest.id);
  // One member with an allowance, so every column shows its widest words.
  const at = `/settings/people/${LONG}/role`;
  const token = createSession(app.db, alice.id).token;
  const cookie = `forge_session=${token}`;
  await fetch(`${servers.url}${at}`, { method: "POST", headers: { cookie, origin: servers.url }, body: new URLSearchParams({ role: "member", usd: "12.50" }), redirect: "manual" });
  session = { name: "forge_session", value: token };
  page = await (await fetch(`${servers.url}/settings/people`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Settings › People at 390 px", () => {
  test("the page renders the seeded long content in many rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain(LONG);
    expect(page.match(/<tr>/g)!.length).toBeGreaterThan(20);
    expect(page).toContain("Make member");
    expect(page).toContain("Make guest");
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s"])(?:min-)?width\s*:/i);
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    const over: string[] = [];
    for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the table scrolls inside its own box, and its text wraps anywhere", () => {
    // The table sits in a `.table-scroll` box carrying `data-people`.
    expect(page).toMatch(/<div class="table-scroll" data-people>\s*<table class="table" id="people">/);
    expect(components).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-people\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|,)\s*\[data-people\]\s*(?:,|$)/);
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    // The role form wraps its input over its button rather than widen the row.
    expect(components).toMatch(/\.row-fields\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});

/**
 * Measured, not read from the CSS: the page in a real Chromium at 390x844
 * does not scroll sideways. Skipped where no Chromium starts; the forge's
 * check runs it and logs the numbers.
 */
const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the people phone look is not measured");

describe.skipIf(chromium === undefined)("Settings › People, measured at 390x844", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const box = document.querySelector("[data-people]");
    const names = [...document.querySelectorAll("#people td:first-child")];
    return JSON.stringify({
      scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, viewportWidth: vw,
      boxRight: box ? Math.round(box.getBoundingClientRect().right) : -1,
      widestName: Math.round(Math.max(0, ...names.map((td) => td.getBoundingClientRect().width))),
      rows: names.length,
    });
  })()`;
  type Measured = { scrollWidth: number; innerWidth: number; viewportWidth: number; boxRight: number; widestName: number; rows: number };

  test("no sideways scroll; the table's box ends inside the screen", async () => {
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/settings/people`, { width: 390, height: 844 }, [session], measure)) as Measured;
    console.log(`people 390x844: ${JSON.stringify(m)}`);
    expect(m.rows).toBeGreaterThan(20);
    expect(m.boxRight).toBeGreaterThan(0);
    expect(m.boxRight).toBeLessThanOrEqual(m.viewportWidth);
    expect(m.widestName).toBeLessThan(m.viewportWidth);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
  }, 30_000);
});
