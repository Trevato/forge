/**
 * The signed-in home fits a 390 px phone (#9378): seeded with a 250-character
 * unbroken word, a long title and many shipped rows, the page fixes no width
 * over 390 px, the rows that hold long text wrap, and in a real Chromium it
 * does not scroll sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { enableApp } from "../src/actions/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "H".repeat(250);
const APP = "a".repeat(100);
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let session: { name: string; value: string };

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-home-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  must(await commitToBranch(app, u, repo, { message: "init", files: [{ path: "README.md", content: "x" }] }));
  const long = must(await createRepo(app, u, { name: APP, visibility: "public" }));
  must(await commitToBranch(app, u, long, { message: "init", files: [{ path: "README.md", content: "x" }] }));
  must(enableApp(app, u, long));
  // The crew's next asks are the home's first lane: a 250-character word, a long title and a few plain ones.
  app.db.run("UPDATE repo SET autonomy = 'autonomous', autonomy_slots = 2 WHERE id = ?1", [repo.id]);
  for (let i = 0; i < 8; i++) {
    const title = i === 0 ? WORD : i === 1 ? "A very long title ".repeat(12).trim() : `Ask ${i} \`code span\``;
    must(createIssue(app.db, { repoId: repo.id, authorId: u.id, title, kind: "issue" }));
  }
  const token = createSession(app.db, u.id).token;
  session = { name: "forge_session", value: token };
  page = await (await fetch(`${servers.url}/`, { headers: { cookie: `forge_session=${token}` } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the signed-in home at 390 px", () => {
  test("the seeded long content is on the page", () => {
    expect(page).toContain("A very long title");
    expect(page).toContain(WORD.slice(0, 40));
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s"])(?:min-)?width\s*:/i);
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    const over: string[] = [];
    for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the long-named app is a tell-box option in the served HTML (first paint)", () => {
    expect(page).toMatch(new RegExp(`<option value="alice/${APP}">`));
  });

  test("the chip wraps and the tell box shrinks: the rules exist, scoped to the home", () => {
    expect(content).toMatch(/\.home-doors a\s*\{[^}]*underline[^}]*min-height:\s*44px/);
    expect(content).toMatch(/\.tell-box \.input\s*\{[^}]*min-width:\s*0/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the home phone look is not measured");

describe.skipIf(chromium === undefined)("the home, measured at 390x844", () => {
  test("no sideways scroll", async () => {
    const measure = `(() => {
      const vw = document.documentElement.clientWidth;
      // Only a one-line ellipsis title inside main is excused: it clips by design.
      const clipped = (el) => { for (let p = el.parentElement; p && p.tagName !== "MAIN"; p = p.parentElement) { const c = getComputedStyle(p); if (c.textOverflow === "ellipsis" && c.overflowX === "hidden") return true; } return false; };
      const overflowing = [...document.querySelectorAll("main *")].filter((el) => el.getBoundingClientRect().right > vw + 1 && !clipped(el)).slice(0, 8).map((el) => el.tagName.toLowerCase() + "." + el.className);
      const tall = [...document.querySelectorAll(".home-doors a")].map((a) => Math.round(a.getBoundingClientRect().height));
      const underlined = [...document.querySelectorAll(".home-doors a")].every((a) => getComputedStyle(a).textDecorationLine.includes("underline"));
      const sel = document.querySelector("#tell-box select");
      const selRight = sel ? Math.round(sel.getBoundingClientRect().right) : -1;
      return JSON.stringify({ tall, underlined, scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, overflowing, selRight });
    })()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/`, { width: 390, height: 844 }, [session], measure)) as { tall: number[]; underlined: boolean; scrollWidth: number; viewportWidth: number; overflowing: string[]; selRight: number };
    console.log(`home 390x844: ${JSON.stringify(m)}`);
    expect(m.tall.length).toBeGreaterThan(1);
    for (const h of m.tall) expect(h).toBeGreaterThanOrEqual(44);
    expect(m.underlined).toBe(true);
    expect(m.selRight).toBeGreaterThan(0);
    expect(m.selRight).toBeLessThanOrEqual(m.viewportWidth);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
