/**
 * A repository's files page fits a 390 px phone (#9376): a directory listing
 * and a file view, seeded with a 250-character unbroken name, a long code line
 * and many rows, fix no width over 390 px; long names wrap and code scrolls in
 * its own box.
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
import { findChromium } from "../src/looks/capture.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "N".repeat(250);
const DIR = "d".repeat(120);
const FILE = `${WORD}.txt`;
const CODE = "const x = " + "y".repeat(290) + ";";
let dir: string;
let app: App;
let servers: Servers;
let listing: string;
let file: string;
let session: { name: string; value: string };
const listingPath = "/alice/fit/tree/main";
const filePath = "/alice/fit/blob/main/code.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const styles = (html: string) => (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tree-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  const repo = must(await createRepo(app, u, { name: "fit", visibility: "public" }));
  const files = [{ path: "code.ts", content: `${CODE}\n` }, { path: FILE, content: "x" }, { path: `${DIR}/${WORD}/inner.txt`, content: "x" }];
  for (let i = 0; i < 40; i++) files.push({ path: `file-${i}.txt`, content: "x" });
  must(await commitToBranch(app, u, repo, { message: "init", files }));
  const token = createSession(app.db, u.id).token;
  session = { name: "forge_session", value: token };
  const cookie = `forge_session=${token}; forge_mode=dev`;
  const get = async (p: string) => (await fetch(`${servers.url}${p}`, { headers: { cookie } })).text();
  listing = await get(listingPath);
  file = await get(filePath);
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the files page at 390 px", () => {
  test("both views render the seeded long content", () => {
    expect(listing).toContain(WORD);
    expect(listing).toContain(DIR);
    expect(listing.match(/file-\d+\.txt/g)!.length).toBeGreaterThanOrEqual(40);
    expect(file).toContain("y".repeat(290));
    expect(file).toContain('class="code');
    expect(file).toContain(WORD);
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    for (const html of [listing, file]) {
      expect(html).not.toMatch(/style="[^"]*(?:^|[;\s"])(?:min-|max-)?width\s*:/i);
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

  test("long names wrap anywhere; code scrolls in its own box", () => {
    expect(content).toMatch(/\.code-layout\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(content).toMatch(/(?:^|\n)\.code\s*\{[^}]*overflow-x:\s*auto/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the files phone look is not measured");

describe.skipIf(chromium === undefined)("the files page, measured at 390x844", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const scope = [...document.querySelectorAll(".code-layout, .code-layout *")];
    const code = document.querySelector(".code");
    const overflowing = scope.filter((el) => !el.closest(".code") && el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase() + "." + el.className);
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, overflowing, codeScrolls: code ? code.scrollWidth > code.clientWidth : null });
  })()`;
  for (const which of ["listing", "file"] as const) {
    test(`${which}: no sideways scroll`, async () => {
      const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${which === "listing" ? listingPath : filePath}`, { width: 390, height: 844 }, [session], measure)) as { scrollWidth: number; viewportWidth: number; overflowing: string[]; codeScrolls: boolean | null };
      console.log(`files ${which} 390x844: ${JSON.stringify(m)}`);
      expect(m.overflowing).toEqual([]);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
      if (which === "file") expect(m.codeScrolls).toBe(true);
    }, 30_000);
  }
});
