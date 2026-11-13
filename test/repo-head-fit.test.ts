/**
 * A repository's head page fits a 390 px phone (#9454): seeded long content (an
 * unbroken description word, a long branch and file name, many rows, a README with
 * a long word, a long code line and a wide table) ships no fixed width over 390 px,
 * and the head, rail and body wrap while code and tables scroll in their own box.
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
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "D".repeat(250);
const RWORD = "R".repeat(250);
const BRANCH = "b" + "-long-branch".repeat(16);
const FILE = "f".repeat(116) + ".txt";
const CODE = "const x = " + "y".repeat(290) + ";";
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let emptyPage: string;
let session: { name: string; value: string };

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const styles = (html: string) => (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-repo-head-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public", description: WORD }));
  const readme = [`# Title`, RWORD, "", "```", CODE, "```", "", "| a | b | c | d |", "|---|---|---|---|", `| ${"1".repeat(80)} | ${"2".repeat(80)} | ${"3".repeat(80)} | 4 |`].join("\n");
  const files = [{ path: "README.md", content: readme }, { path: FILE, content: "x" }];
  for (let i = 0; i < 40; i++) files.push({ path: `file-${i}.txt`, content: "x" });
  must(await commitToBranch(app, u, repo, { message: "init", files }));
  must(await commitToBranch(app, u, repo, { message: "branch", branch: BRANCH, files: [{ path: "b.txt", content: "b" }] }));
  must(await createRepo(app, u, { name: "empty", visibility: "public", description: WORD }));
  const token = createSession(app.db, u.id).token;
  session = { name: "forge_session", value: token };
  const cookie = `forge_session=${token}; forge_mode=dev`;
  const get = async (p: string) => (await fetch(`${servers.url}${p}`, { headers: { cookie } })).text();
  page = await get(`/alice/fit?ref=${encodeURIComponent(BRANCH)}`);
  emptyPage = await get("/alice/empty");
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a repository's head page at 390 px", () => {
  test("the long content is on the page, in many rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain(BRANCH);
    expect(page).toContain(FILE);
    expect(page).toContain(RWORD);
    expect(page).toContain("y".repeat(290));
    expect(page).toContain("<table");
    expect(page.match(/class="row[ "]/g)?.length ?? 0).toBeGreaterThanOrEqual(40);
    expect(emptyPage).toContain(WORD);
  });

  test("no inline width and no shipped rule fixes a width over 390 px", () => {
    for (const html of [page, emptyPage]) {
      expect(html).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
      for (const m of html.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
      const over: string[] = [];
      for (const css of [base, components, content, styles(html)]) {
        for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
          if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
        }
      }
      expect(over).toEqual([]);
    }
  });

  test("the head, the rail and the body wrap anywhere", () => {
    expect(page).toContain('class="repo-head');
    expect(page).toContain('<aside aria-label="About"');
    expect(page).toMatch(/class="split"/);
    expect(content).toMatch(/\.repo-head, \.split > aside\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(content).toMatch(/\.split\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(emptyPage).toContain('class="repo-head');
  });

  test("the branch picker shrinks and its label truncates", () => {
    expect(page).toMatch(/<span class="truncate">b-long-branch/);
    expect(content).toMatch(/\.bar > \.menu\s*\{[^}]*min-width:\s*0/);
    expect(content).toMatch(/\.bar > \.menu\s*\{[^}]*flex:\s*0 1 auto/);
    expect(content).toMatch(/\.bar > \.menu > summary \.truncate\s*\{[^}]*min-width:\s*0/);
  });

  test("README code and tables scroll inside their own box", () => {
    expect(page).toContain('class="prose"');
    expect(content).toMatch(/\.prose pre, \.prose table\s*\{[^}]*overflow-x:\s*auto/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the repository head phone look is not measured");

describe.skipIf(chromium === undefined)("a repository's head page, measured at 390x844", () => {
  test("no sideways scroll, and what overflows is named", async () => {
    const measure = `(() => {
      const vw = document.documentElement.clientWidth;
      const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + [...el.classList].map((c) => "." + c).join("");
      const wide = [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > vw + 1 && el.getBoundingClientRect().width > 0)
        .slice(0, 12).map((el) => name(el) + " " + Math.round(el.getBoundingClientRect().width) + "px");
      return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, wide });
    })()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/alice/fit`, { width: 390, height: 844 }, [session], measure)) as { scrollWidth: number; viewportWidth: number; wide: string[] };
    console.log(`repo head 390x844: ${JSON.stringify(m)}`);
    if (m.scrollWidth > m.viewportWidth) throw new Error(`the page scrolls sideways (${m.scrollWidth} > ${m.viewportWidth}); wider than the window: ${m.wide.join(", ")}`);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
