/**
 * The waves page fits a 390 px phone (#9325): seeded long content (a 300-char
 * unbroken word, a long title, many rows) ships no fixed width over 390 px,
 * and the long-text container wraps anywhere.
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
import { PREVIEW_OWNER_LOOKS, PREVIEW_WAVES_PAGE } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { writeWave } from "../src/story/wave.ts";

const WORD = "W".repeat(300);
let dir: string;
let app: App;
let servers: Servers;
let page: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-waves-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  const files = Array.from({ length: 30 }, (_, i) => {
    const headline = i === 0 ? WORD : i === 1 ? "A very long headline ".repeat(12).trim() : `Wave number ${i}`;
    const r = writeWave({ version: `0.${i + 1}.0`, date: "2026-01-01", headline, highlights: [1, 2, 3].map((n) => ({ title: `T${n}`, why: "w" })), pulls: [{ title: "#1 A pull", url: "https://forge.example/o/r/pulls/1" }] });
    return { path: `waves/0.${i + 1}.0.md`, content: must(r) };
  });
  must(await commitToBranch(app, u, repo, { message: "waves", files }));
  const cookie = `forge_session=${createSession(app.db, u.id).token}; forge_mode=dev`;
  page = await (await fetch(`${servers.url}/alice/fit/waves`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the waves page at 390 px", () => {
  test("the long content is on the page, in many rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("A very long headline");
    expect(page.match(/class="row[ "]/g)?.length ?? 0).toBeGreaterThanOrEqual(30);
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
    expect(page).toContain("<div class=\"mt\" data-waves>");
    const css = (page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");
    expect(css).toMatch(/\[data-waves\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(css).toMatch(/\[data-waves\] \.row-title[^{]*\{[^}]*white-space:\s*normal/);
  });
});

test("the owner's phone look takes the waves page", () => {
  expect(PREVIEW_WAVES_PAGE).toBe("/preview-admin/sample/waves");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_WAVES_PAGE, kind: "phone" });
});
