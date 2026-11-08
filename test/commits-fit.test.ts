/**
 * The commits list and a commit's page fit a 390 px phone (#9348): seeded long
 * content (a 300-character unbroken word, a long title, many rows) ships no
 * fixed width over 390 px, long text wraps anywhere, and a diff scrolls in its box.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_COMMITS_PAGE, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";

const WORD = "W".repeat(300);
let dir: string;
let app: App;
let servers: Servers;
let list: string;
let one: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-commits-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  for (let i = 0; i < 12; i++) {
    const message = i === 0 ? `${WORD}\n\n${WORD}` : i === 1 ? "A very long subject ".repeat(10).trim() : `Commit ${i}`;
    must(await commitToBranch(app, u, repo, { message, files: [{ path: `f${i}.txt`, content: `${"x".repeat(400)}\n` }] }));
  }
  const cookie = `forge_session=${createSession(app.db, u.id).token}; forge_mode=dev`;
  list = await (await fetch(`${servers.url}/alice/fit/commits`, { headers: { cookie } })).text();
  const newest = list.match(/\/alice\/fit\/commit\/([0-9a-f]{40})/)![1]!;
  // The oldest-but-one commit carries the unbroken word; find it by its page.
  for (const m of list.matchAll(/\/alice\/fit\/commit\/([0-9a-f]{40})/g)) {
    const text = await (await fetch(`${servers.url}${m[0]}`, { headers: { cookie } })).text();
    if (text.includes(WORD)) { one = text; break; }
  }
  one ??= await (await fetch(`${servers.url}/alice/fit/commit/${newest}`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const styles = (html: string) => (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");

describe("the commits list and a commit's page at 390 px", () => {
  test("the long content is on both pages", () => {
    expect(list).toContain(WORD);
    expect(list).toContain("A very long subject");
    expect(list.match(/class="row[ "]/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(one).toContain(WORD);
    expect(one).toContain("diff-body");
  });

  for (const [name, get] of [["list", () => list], ["commit", () => one]] as const) {
    test(`the ${name} ships no width over 390 px`, () => {
      const page = get();
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

    test(`the ${name}'s long-text container wraps anywhere, rows may wrap`, () => {
      const page = get();
      expect(page).toContain("data-commits");
      expect(styles(page)).toMatch(/\[data-commits\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
      expect(styles(page)).toMatch(/\[data-commits\] \.row-title[^{]*\{[^}]*white-space:\s*normal/);
    });
  }

  test("the commit body (the 300-character word) sits inside [data-commits] and wraps", () => {
    const start = one.indexOf("<div data-commits>");
    const body = one.indexOf('data-text="message"');
    const diff = one.indexOf("diff-body");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(start);
    expect(one.indexOf(WORD, body)).toBeGreaterThan(body);
    // The container closes before the diff, which has its own scrolling box.
    expect(one.indexOf(WORD, body)).toBeLessThan(diff);
    expect(content).toMatch(/\.prose\[data-text="message"\] pre \{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/);
  });

  test("a diff scrolls inside its own box", () => {
    expect(content).toMatch(/\.diff-body \{[^}]*overflow-x:\s*auto/);
  });
});

test("the owner's phone look takes the commits list", () => {
  expect(PREVIEW_COMMITS_PAGE).toBe("/preview-admin/sample/commits");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_COMMITS_PAGE, kind: "phone" });
});
