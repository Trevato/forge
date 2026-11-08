/**
 * An issue's page fits a 390 px phone (#9384): seeded long content (an unbroken
 * 300-character word, a long title, many comments) ships no fixed width over
 * 390 px, and the long-text container wraps anywhere; code may scroll inside
 * its own box. Where a Chromium starts, the page is measured at 390x844.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_ISSUE_PAGE, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "W".repeat(300);
const TITLE = "A very long title ".repeat(10).trim();
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
  dir = await mkdtemp(join(tmpdir(), "forge-issue-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  const issue = must(openIssue(app, u, repo, { title: TITLE, body: `${WORD}\n\n\`\`\`\n${"code ".repeat(80)}\n\`\`\`` }));
  for (let i = 0; i < 15; i++) must(addComment(app, u, repo, issue, i === 0 ? WORD : `Comment ${i} ${"words ".repeat(20)}`));
  cookie = `forge_session=${createSession(app.db, u.id).token}`;
  page = await (await fetch(`${servers.url}/alice/fit/issues/${issue.number}`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("an issue's page at 390 px", () => {
  test("the long content is on the page, in many comments", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("A very long title");
    expect(page.match(/data-kind="comment"/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
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

  test("the container wraps anywhere, and code scrolls inside its own box", () => {
    expect(page).toContain("data-tell");
    const css = content;
    expect(css).toMatch(/\[data-tell\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(css).toMatch(/\[data-tell\] \.split > \*\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\[data-tell\] \.page-head-sub\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\[data-tell\] \.comment-body img\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\[data-tell\] pre\s*\{[^}]*overflow-x:\s*auto/);
  });
});

test("the owner's phone look takes an issue's page", () => {
  expect(PREVIEW_ISSUE_PAGE).toBe("/preview-admin/sample/issues/1");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_ISSUE_PAGE, kind: "phone" });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the issue page is not measured");

describe.skipIf(chromium === undefined)("measured at 390x844", () => {
  test("no sideways scroll", async () => {
    const measure = `(() => JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
      comments: document.querySelectorAll(".comment").length }))()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/alice/fit/issues/1`, { width: 390, height: 844 }, [{ name: "forge_session", value: cookie.split("=")[1]! }], measure));
    console.log(`issue look 390x844: ${JSON.stringify(m)}`);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
