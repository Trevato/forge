/**
 * Settings › Crew fits a 390 px phone (#9373): seeded with agents whose name
 * is long and whose brief holds a 250-character unbroken word, the page fixes
 * no width over 390 px and its rows and long text wrap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "B".repeat(250);
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let session: { name: string; value: string };
const PATH = "/alice/fit/settings";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-crew-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const cookie = ((await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const alice = getUserByName(app.db, "alice")!;
  const r = await createRepo(app, alice, { name: "fit", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  for (let n = 0; n < 12; n++) {
    const name = n === 0 ? "a".repeat(39) : `agent-${n}`;
    const a = await createAgent(app, alice, { username: name, model: "", brief: n < 3 ? WORD : "A long and winding brief about who this agent is. ".repeat(4) });
    if (!a.ok) throw new Error(String(a.error));
    const added = addToCrew(app, alice, r.value, name);
    if (!added.ok) throw new Error(String(added.error));
  }
  session = { name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1) };
  page = await (await fetch(`${servers.url}${PATH}`, { headers: { cookie } })).text();
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Settings › Crew at 390 px", () => {
  test("the page renders the seeded crew", () => {
    expect(page).toContain(WORD);
    expect(page).toContain("data-crew-settings");
    expect(page.match(/action="[^"]*\/settings\/crew\/[^"]*\/remove"/g)!.length).toBeGreaterThanOrEqual(12);
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
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
  });

  test("the crew list wraps its rows, and its container wraps anywhere", () => {
    const crew = page.slice(page.indexOf('id="crew"'));
    expect(crew).toContain('<ul class="list setting-list">');
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-crew-settings\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    expect(components).toMatch(/\.setting-list \.row-title[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the crew settings phone look is not measured");

describe.skipIf(chromium === undefined)("Settings › Crew, measured at 390x844", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const scope = [...document.querySelectorAll("[data-crew-settings], [data-crew-settings] *")];
    const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, scoped: scope.length, overflowing });
  })()`;
  test("no sideways scroll", async () => {
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${PATH}`, { width: 390, height: 844 }, [session], measure)) as { scrollWidth: number; viewportWidth: number; scoped: number; overflowing: string[] };
    console.log(`crew settings 390x844: ${JSON.stringify(m)}`);
    expect(m.scoped).toBeGreaterThan(0);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
