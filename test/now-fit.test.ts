/**
 * The /now/:stage pages fit a 390 px phone (#9377): seeded with a 250-character
 * unbroken title and many rows, no stage fixes a width over 390 px, and long
 * words wrap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { NOW_STAGES, type NowStage } from "../src/flow/now_rows.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";
import { promote } from "./helpers/members.ts";

const WORD = "T".repeat(250);
let dir: string;
let app: App;
let servers: Servers;
let session: { name: string; value: string };
const pages = {} as Record<NowStage, string>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-now-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "root", allowReserved: true, email: "r@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  promote(app.db, made.value);
  const token = createSession(app.db, made.value.id).token;
  session = { name: "forge_session", value: token };
  const alice = getUserByName(app.db, "root")!;
  const r = await createRepo(app, alice, { name: "fit", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const pull = (title: string) => {
    const i = createIssue(app.db, { repoId: r.value.id, authorId: alice.id, title, kind: "pull" });
    if (!i.ok) throw new Error(i.error);
    app.db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', 'h')").run(i.value.id, `h-${crypto.randomUUID()}`);
    return i.value;
  };
  const run = (kind: string, state: string, issueId: string | null, extra: { reason?: string; env?: string; serving?: boolean } = {}) =>
    app.db
      .query("INSERT INTO run (id, repo_id, kind, issue_id, env, state, reason, serving_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), r.value.id, kind, issueId, extra.env ?? "", state, extra.reason ?? "", extra.serving ? new Date().toISOString() : null);
  for (let n = 0; n < 12; n++) {
    const title = n === 0 ? WORD : n === 1 ? "A long and winding pull title ".repeat(8) : `Pull ${n} ${WORD.slice(0, 200)}`;
    const p = pull(title);
    run("check", n % 2 ? "queued" : "running", p.id);
    run("agent", "running", p.id, { reason: "review" });
    app.db.query("INSERT INTO review (id, issue_id, author_id, state) VALUES (?, ?, ?, 'approved')").run(crypto.randomUUID(), p.id, alice.id);
    run("deploy", "ok", null, { env: "production", serving: true });
  }
  for (const stage of NOW_STAGES) pages[stage] = await (await fetch(`${servers.url}/now/${stage}`, { headers: { cookie: `forge_session=${token}` } })).text();
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the /now/:stage pages at 390 px", () => {
  test("every stage renders many rows, the long ones carrying the seeded word", () => {
    for (const stage of NOW_STAGES) {
      expect(pages[stage].match(/<li/g)!.length).toBeGreaterThan(5);
      expect(pages[stage]).toContain("data-now");
    }
    for (const stage of ["check", "review", "land"] as const) expect(pages[stage]).toContain(WORD);
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    for (const stage of NOW_STAGES) {
      const page = pages[stage];
      expect(page).not.toMatch(/style="[^"]*(?:^|[;\s"])(?:min-)?width\s*:/i);
      for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
      const over: string[] = [];
      for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
        for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
          const px = Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16);
          if (px > 390) over.push(m[0]);
        }
      }
      expect(over).toEqual([]);
    }
  });

  test("the list wraps its rows instead of truncating a long title", () => {
    for (const stage of NOW_STAGES) {
      expect(pages[stage]).toContain('<ul class="list setting-list">');
      expect(pages[stage]).not.toContain('class="truncate"');
    }
  });

  test("long-text containers wrap anywhere", () => {
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-now\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|,)\s*\[data-now\]\s*(?:,|$)/);
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    expect(components).toMatch(/\.setting-list \.row-title[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the now phone look is not measured");

describe.skipIf(chromium === undefined)("the /now/:stage pages, measured at 390x844", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const scope = [...document.querySelectorAll("[data-now], [data-now] *")];
    const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, wrapped: scope.length > 0, overflowing, rows: document.querySelectorAll("[data-now] li").length });
  })()`;
  for (const stage of NOW_STAGES) {
    test(`${stage}: no sideways scroll`, async () => {
      const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/now/${stage}`, { width: 390, height: 844 }, [session], measure)) as { scrollWidth: number; viewportWidth: number; wrapped: boolean; overflowing: string[]; rows: number };
      console.log(`now ${stage} 390x844: ${JSON.stringify(m)}`);
      expect(m.wrapped).toBe(true);
      expect(m.rows).toBeGreaterThan(5);
      expect(m.overflowing).toEqual([]);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
    }, 30_000);
  }
});
