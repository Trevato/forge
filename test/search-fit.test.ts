/**
 * The search page fits a 390 px phone (#9351): seeded long content (a 246-character (the longest a title may be)
 * unbroken word in a title, a long title, a long code path and line, many rows)
 * ships no fixed width over 390 px, long text wraps anywhere, and a line of code
 * scrolls inside its own box.
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
import { PREVIEW_OWNER_LOOKS, PREVIEW_SEARCH_PAGE } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";

const WORD = "sample" + "P".repeat(240);
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let blank: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-search-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public", description: "sample " + "D".repeat(300) }));
  must(await commitToBranch(app, u, repo, { message: "init", files: [{ path: `dir/${"q".repeat(120)}.txt`, content: `sample ${"x".repeat(300)}\n` }] }));
  for (let i = 0; i < 12; i++) {
    const title = i === 0 ? WORD : i === 1 ? "sample very long title ".repeat(8).trim() : `sample issue number ${i}`;
    must(openIssue(app, u, repo, { title }));
  }
  const cookie = `forge_session=${createSession(app.db, u.id).token}; forge_mode=dev`;
  page = await (await fetch(`${servers.url}/search?q=sample`, { headers: { cookie } })).text();
  blank = await (await fetch(`${servers.url}/search`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("/search at 390 px", () => {
  test("the long content is on the page, in many rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("sample very long title");
    expect(page).toContain("q".repeat(120));
    expect(page.match(/class="row[ "]/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
  });

  test("no inline width and no shipped rule fixes a width over 390 px", () => {
    for (const html of [page, blank]) {
      expect(html).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
      for (const m of html.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    }
    const over: string[] = [];
    for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the results' container wraps anywhere; a code line scrolls in its own box", () => {
    expect(page).toContain("data-search");
    expect(blank).toContain("data-search");
    const css = (page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");
    expect(css).toMatch(/\[data-search\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(css).toMatch(/\[data-search\] \.row-title[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).toMatch(/\[data-search\] \.code-line\s*\{[^}]*overflow-x:\s*auto/);
  });
});

test("the owner's phone look takes the search page", () => {
  expect(PREVIEW_SEARCH_PAGE).toBe("/search?q=sample");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_SEARCH_PAGE, kind: "phone" });
});
