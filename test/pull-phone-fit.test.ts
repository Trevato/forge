/**
 * A pull's page fits a 390 px phone (#9327): the preview seed's pull, given a
 * long title, a 200-character branch name and a comment holding a 300-character
 * unbroken word, ships no fixed width over 390 px, wraps its long text, and
 * (where a Chromium starts) does not scroll sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { addComment } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { findChromium } from "../src/looks/capture.ts";
import { PREVIEW_OWNER_LOOKS, PREVIEW_PULL_FILES, PREVIEW_PULL_PAGE } from "../src/spawn/preview-looks.ts";
import { previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";
import { base as elements, utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const KEY = "pull-phone-fit-key";
const WORD = "w".repeat(300);
const BRANCH = `feature/${"b".repeat(192)}`;
const TITLE = `Make every long and winding pull title wrap ${"t".repeat(120)} and many words after it`;
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let files: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-pull-fit-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  const admin = previewAdmin(app)!;
  const number = Number(PREVIEW_PULL_PAGE.split("/").pop());
  const issue = app.db.query("SELECT id FROM issue WHERE number = ?1 AND id IN (SELECT issue_id FROM pull)").get(number) as { id: string };
  app.db.query("UPDATE issue SET title = ?1 WHERE id = ?2").run(TITLE, issue.id);
  app.db.query("UPDATE pull SET head_branch = ?1 WHERE issue_id = ?2").run(BRANCH, issue.id);
  for (let i = 0; i < 12; i++) addComment(app.db, { issueId: issue.id, authorId: admin.id, body: `Row ${String(i)} ${WORD} https://example.com/${WORD}` });
  servers = await serve(app);
  const said = `u1|trevato|admin|${Date.now() + 60_000}`;
  const headers = { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
  page = await (await fetch(`${servers.url}${PREVIEW_PULL_PAGE}`, { headers })).text();
  files = await (await fetch(`${servers.url}${PREVIEW_PULL_PAGE}/files`, { headers })).text();
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** Every `width`/`min-width` in `css` that fixes more than 390 px, as written. */
const widthsOver390 = (css: string): string[] =>
  [...css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)]
    .filter((m) => Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390)
    .map((m) => m[0]);

describe("a pull's conversation page at 390 px", () => {
  test("the seeded long content is on the page", () => {
    expect(page).toContain(TITLE);
    expect(page).toContain(WORD);
    // The branch is drawn where the pull says where it came from: the Files step.
    expect(files).toContain(BRANCH);
  });

  test("no inline width and no rule the page ships fixes a width over 390 px", () => {
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s])min-width\s*:/i);
    const sheets = [base, components, content, ...[page, files].flatMap((html) => html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])];
    const inline = [...page.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
    expect([...inline, ...sheets].flatMap(widthsOver390)).toEqual([]);
  });

  test("the long-text containers wrap anywhere", () => {
    expect(components).toMatch(/\.page-head h1[^{]*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(elements).toMatch(/\.mono[^{]*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(content).toMatch(/\.prose\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the pull's phone look is not measured");

describe.skipIf(chromium === undefined)("a pull's conversation page, measured", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== "visible") return true; } return false; };
    const overflowing = [...document.querySelectorAll(".page-head, .page-head *, .split, .split *")].filter((el) => el.getBoundingClientRect().right > vw + 1 && !clipped(el) && getComputedStyle(el).clipPath === "none" && getComputedStyle(el).position !== "fixed").slice(0, 8).map((el) => el.tagName.toLowerCase() + "." + String(el.className));
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, overflowing });
  })()`;
  // The layout's own chrome (tabs, off-canvas menus) is web-phone.test.ts's to hold; the page's content is measured here.
  const look = async (width: number, height: number) => {
    const cookies = [{ name: "forge_session", value: createSession(app.db, previewAdmin(app)!.id).token }];
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${PREVIEW_PULL_PAGE}`, { width, height }, cookies, measure)) as { scrollWidth: number; viewportWidth: number; overflowing: string[] };
    console.log(`pull look ${width}x${height}: ${JSON.stringify(m)}`);
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

describe("a pull's Files tab with a line comment (#10073)", () => {
  test("the seeded diff carries the review comment", () => {
    expect(files).toContain("Say hello to the whole forge");
  });
  test("the preview takes looks of the Files tab at desk and phone", () => {
    const taken = PREVIEW_OWNER_LOOKS.filter((l) => l.page === PREVIEW_PULL_FILES).map((l) => l.kind).sort();
    expect(taken).toEqual(["desktop", "phone"]);
  });
});

describe.skipIf(chromium === undefined)("a pull's Files tab with a line comment, measured", () => {
  const measure = `JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth, comment: document.body.textContent.includes("Say hello to the whole forge") })`;
  const look = async (width: number, height: number) => {
    const cookies = [{ name: "forge_session", value: createSession(app.db, previewAdmin(app)!.id).token }];
    return JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${PREVIEW_PULL_FILES}`, { width, height }, cookies, measure)) as { scrollWidth: number; viewportWidth: number; comment: boolean };
  };
  test("phone, 390x844: no sideways scroll", async () => {
    const m = await look(390, 844);
    expect(m.comment).toBe(true);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
  test("desk, 1280x800: no sideways scroll", async () => {
    const m = await look(1280, 800);
    expect(m.comment).toBe(true);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
