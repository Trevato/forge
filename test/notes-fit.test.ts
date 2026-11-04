/**
 * The owner's /notes page fits a 390 px phone (#9352): seeded long notes (an
 * unbroken 300-character word, a long sentence, many rows) ship no fixed width
 * over 390 px, and the long-text container wraps anywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { keepThought } from "../src/actions/thought.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { NOTES_CSS } from "../src/web/pages/notes.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "N".repeat(300);
const SENTENCE = "A long note that says a great deal so it cannot fit on one line ".repeat(5).trim();

let dir: string;
let app: App;
let servers: Servers;
let page: string;
let userId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-notes-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error("user");
  userId = u.value.id;
  keepThought(app, u.value, WORD, "composer");
  keepThought(app, u.value, SENTENCE, "composer");
  for (let i = 0; i < 40; i++) keepThought(app, u.value, `Note number ${i}`, "composer");
  const res = await fetch(`${servers.url}/notes`, { headers: { cookie: `forge_session=${createSession(app.db, userId).token}` } });
  expect(res.status).toBe(200);
  page = await res.text();
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const styles = (h: string): string[] => h.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [];

describe("the notes page at 390 px", () => {
  test("the long notes render, in many rows", () => {
    expect(page).toContain(WORD.slice(0, 150));
    expect(page).toContain(SENTENCE.slice(0, 100));
    expect(page.match(/class="row"/g)?.length ?? 0).toBeGreaterThan(30);
  });

  test("the rows sit inside the wrapping container", () => {
    expect(page).toContain("data-notes");
    expect(page.indexOf("data-notes")).toBeLessThan(page.indexOf('class="list"'));
  });

  test("no inline width and no shipped rule fixes a width over 390 px", () => {
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    const over: string[] = [];
    for (const css of [base, components, content, NOTES_CSS, ...styles(page)]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the container wraps anywhere, and a row's title and meta may wrap", () => {
    const css = styles(page).join("\n");
    expect(css).toMatch(/\[data-notes\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(css).toMatch(/\[data-notes\] \.row-title[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).toMatch(/\[data-notes\] \.row-meta[^{]*\{[^}]*white-space:\s*normal/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the notes phone look is not measured");

describe.skipIf(chromium === undefined)("the notes page, measured", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const overflowing = [...document.querySelectorAll("[data-notes], [data-notes] *")].filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase() + "." + String(el.className));
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, overflowing });
  })()`;
  const look = async (width: number, height: number) => {
    const cookies = [{ name: "forge_session", value: createSession(app.db, userId).token }];
    return JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/notes`, { width, height }, cookies, measure)) as { scrollWidth: number; viewportWidth: number; overflowing: string[] };
  };
  test("phone, 390x844: no sideways scroll", async () => {
    const m = await look(390, 844);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
