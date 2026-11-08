/**
 * The issues list fits a 390 px phone (#9344): seeded long content (an unbroken
 * 250-character word, the longest a title may be, plus a long title and many rows)
 * ships no fixed width over 390 px, and the long-text container wraps anywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_OWNER_LOOKS, PREVIEW_ISSUES_PAGE } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";

const WORD = "P".repeat(250);
let dir: string;
let app: App;
let servers: Servers;
let page: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-issues-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  must(await commitToBranch(app, u, repo, { message: "init", files: [{ path: "README.md", content: "x" }] }));
  for (let i = 0; i < 12; i++) {
    const title = i === 0 ? WORD : i === 1 ? "A very long title ".repeat(12).trim() : `Issue number ${i}`;
    must(openIssue(app, u, repo, { title }));
  }
  const cookie = `forge_session=${createSession(app.db, u.id).token}; forge_mode=dev`;
  page = await (await fetch(`${servers.url}/alice/fit/issues`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the issues list at 390 px", () => {
  test("the long content is on the page, in many rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("A very long title");
    expect(page.match(/class="row[ "]/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
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

  test("the list's container wraps anywhere, and its rows may wrap", () => {
    expect(page).toContain("data-tells");
    const css = (page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");
    expect(css).toMatch(/\[data-tells\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(css).toMatch(/\[data-tells\] \.row-title[^{]*\{[^}]*white-space:\s*normal/);
  });
});

describe("the issues list speaks the home page's language (#9741)", () => {
  test("the list is bare rows on the page, not a boxed card", () => {
    expect(page).toMatch(/class="card bare"/);
    expect(page.match(/<li[^>]*>\s*<a href="\/alice\/fit\/issues\/\d+" class="row"/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
  });

  test("a title is the system's row title: the list sets no type size of its own", () => {
    const css = (page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");
    expect(css).not.toMatch(/\[data-tells\][^{]*\{[^}]*font-size/);
  });
});

test("the owner's phone look takes the issues list", () => {
  expect(PREVIEW_ISSUES_PAGE).toBe("/preview-admin/sample/issues");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_ISSUES_PAGE, kind: "phone" });
});
