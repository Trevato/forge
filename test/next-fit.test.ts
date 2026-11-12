/**
 * The next-up page fits a 390 px phone (#9324): seeded long content (an
 * unbroken 300-character word, a long title, many rows) ships no fixed width
 * over 390 px, the long-text container wraps anywhere, and a row's actions
 * wrap under its text in place of squeezing it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_NEXT_PAGE, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "N".repeat(250);
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let cookie: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-next-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  for (let i = 0; i < 14; i++) {
    const title = i === 0 ? WORD : i === 1 ? "A very long title ".repeat(12).trim() : `Work item ${i}`;
    must(openIssue(app, u, repo, { title, body: "" }));
  }
  cookie = `forge_session=${createSession(app.db, u.id).token}`;
  page = await (await fetch(`${servers.url}/alice/fit/next?all=1`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the next-up page at 390 px", () => {
  test("the long content is on the page, in many rows, each with actions", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("A very long title");
    expect(page.match(/<li[^>]*data-number=/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(page).toContain("row-after");
  });

  test("no inline width and no shipped rule fixes a width over 390 px", () => {
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    const over: string[] = [];
    for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the container wraps anywhere, and a row's actions wrap under its text", () => {
    expect(page).toContain("data-next");
    const css = (page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");
    expect(css).toMatch(/\[data-next\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(css).toMatch(/\[data-next\] \.list > li\.has-after > \.row\s*\{[^}]*flex:\s*1 1 14rem/);
    expect(css).toMatch(/\[data-next\] \.row-after\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});

test("the owner's phone look takes the next-up page", () => {
  expect(PREVIEW_NEXT_PAGE).toBe("/preview-admin/sample/next");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_NEXT_PAGE, kind: "phone" });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the next-up phone look is not measured");

describe.skipIf(chromium === undefined)("measured at 390x844", () => {
  test("no sideways scroll, and no row taller than the screen", async () => {
    const measure = `(() => JSON.stringify({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
      tall: [...document.querySelectorAll("#next-list li[data-number]")].filter((li) => li.getBoundingClientRect().height > 844).length }))()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/alice/fit/next?all=1`, { width: 390, height: 844 }, [{ name: "forge_session", value: cookie.split("=")[1]! }], measure));
    console.log(`next look 390x844: ${JSON.stringify(m)}`);
    expect(m.sw).toBeLessThanOrEqual(m.vw);
    expect(m.tall).toBe(0);
  }, 30_000);
});
