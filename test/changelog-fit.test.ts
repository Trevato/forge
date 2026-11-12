/**
 * The changelog fits a 390 px phone (#9349): seeded long content (an unbroken
 * 300-character word, a long title, many rows) ships no fixed width over
 * 390 px, and the long-text container wraps anywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "C".repeat(300);
let dir: string;
let app: App;
let servers: Servers;
let page: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-changelog-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error("user");
  const made = await createRepo(app, r.value, { name: "forge", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  app.config.forgeRepo = "alice/forge";
  const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'forge'").get()!.id;
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 15; i++) {
    const title = i === 0 ? WORD : i === 1 ? "A very long title ".repeat(12).trim() : `Pull number ${i}`;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'closed', ?6)`).run(`i${i}`, repoId, i + 1, title, r.value.id, `${day}T01:00:00.000Z`);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, 'main', ?2, '', '', ?3, ?4, '')`).run(`i${i}`, `b/${i}`, repoId, `${day}T01:00:00.000Z`);
  }
  page = await (await fetch(`${servers.url}/changelog`)).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the changelog at 390 px", () => {
  test("the long content is on the page, in many rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("A very long title");
    expect(page.match(/class="row[ "]/g)?.length ?? 0).toBeGreaterThanOrEqual(15);
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

  test("the day lists reuse .setting-list, whose shared rule wraps titles and the trail", () => {
    expect(page).not.toContain("<style>[data-changelog]");
    expect(page).not.toContain("data-changelog");
    expect(page.match(/<ul class="list setting-list">/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(components).toMatch(/\.setting-list \.row-title, \.setting-list \.row-meta \{[^}]*white-space: normal[^}]*overflow-wrap: anywhere/);
    expect(components).toMatch(/\.setting-list \.row \{[^}]*flex-wrap: wrap/);
    expect(components).toMatch(/@media \(max-width: 640px\) \{ \.setting-list \.row-trail \{ flex-basis: 100%/);
  });
});

test("the preview takes a phone look of /changelog", async () => {
  const { PREVIEW_CHANGELOG_PAGE, PREVIEW_OWNER_LOOKS } = await import("../src/spawn/preview-looks.ts");
  expect(PREVIEW_CHANGELOG_PAGE).toBe("/changelog");
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: "/changelog", kind: "phone" });
});

/** The preview's own /changelog: the seed lands one long-titled pull, the row its phone look shows (#9349). */
describe("the preview's changelog", () => {
  let pdir: string;
  let papp: App;
  let pservers: Servers;
  let ppage: string;
  beforeAll(async () => {
    const { seedPreview } = await import("../src/spawn/preview-seed.ts");
    pdir = await mkdtemp(join(tmpdir(), "forge-changelog-preview-"));
    papp = createApp({ dataDir: pdir, port: 0 });
    const seeded = await seedPreview(papp, { FORGE_APP_ENV: "preview" });
    if (!seeded.ok) throw new Error(seeded.error);
    pservers = await serve(papp);
    ppage = await (await fetch(`${pservers.url}/changelog`)).text();
  }, 30_000);
  afterAll(async () => {
    pservers.stop();
    papp.close();
    await rm(pdir, { recursive: true, force: true });
  });

  test("lists the seeded landing in a .setting-list day", async () => {
    const { PREVIEW_LANDING_TITLE } = await import("../src/spawn/preview-seed.ts");
    const list = ppage.match(/<ul class="list setting-list">[\s\S]*?<\/ul>/)?.[0] ?? "";
    expect(list).toContain(PREVIEW_LANDING_TITLE);
  });

  const found = findChromium();
  const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
  if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the changelog's phone look is not measured");
  test.skipIf(chromium === undefined)("phone, 390x844: no sideways scroll", async () => {
    const measure = `JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth })`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${pservers.url}/changelog`, { width: 390, height: 844 }, [], measure)) as { scrollWidth: number; viewportWidth: number };
    console.log(`changelog look 390x844: ${JSON.stringify(m)}`);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
