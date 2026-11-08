/**
 * The forges pages fit a 390 px phone (#9372): /forges seeded with a
 * 250-character unbroken name, "for whom" and app list and many rows, and
 * /forges/new with a long name in its field, fix no width over 390 px, wrap
 * long words, and (measured in Chromium where one runs) do not scroll sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const WORD = "w".repeat(250);
let dir: string;
let app: App;
let servers: Servers;
let list: string;
let form: string;
let session: { name: string; value: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-forges-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const cookie = ((await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  session = { name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1) };
  await mkdir(join(dir, "spawn"), { recursive: true });
  for (let n = 0; n < 25; n++) {
    const name = n === 0 ? "n".repeat(240) : `forge-${n}`;
    await Bun.write(
      join(dir, "spawn", `${name}.json`),
      JSON.stringify({ name, bodyId: `b${n}`, url: "", planHash: "x", done: n % 2 === 0, forWhom: n < 3 ? WORD : `Client ${n} with a rather long and winding description `.repeat(2), apps: n < 3 ? [WORD, `alice/${WORD}`] : ["alice/notes", "alice/todo"], createdAt: new Date().toISOString() }),
    );
  }
  const get = async (path: string) => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
  list = await get("/forges");
  form = await get(`/forges/new?name=${"n".repeat(38)}`);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the forges pages at 390 px", () => {
  test("both pages render the seeded long content", () => {
    expect(list).toContain(WORD);
    expect(list).toContain("n".repeat(240));
    expect(list.match(/data-forge="/g)!.length).toBeGreaterThan(20);
    expect(form).toContain("n".repeat(38));
    expect(list).toContain("data-forges");
    expect(form).toContain("data-forges");
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    for (const page of [list, form]) {
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

  test("long-text containers wrap anywhere, and the table scrolls in its own box", () => {
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-forges\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|,)\s*\[data-forges\]\s*(?:,|$)/);
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
    expect(content).toMatch(/\[data-forges\] \.row-trail\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(content).toMatch(/\[data-forges\] \.row-title[^{]*\{[^}]*white-space:\s*normal[^}]*overflow:\s*visible/);
    expect(list).toContain('class="table-scroll"');
    expect(components).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the forges phone look is not measured");

describe.skipIf(chromium === undefined)("the forges pages, measured at 390x844", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const scope = [...document.querySelectorAll("[data-forges], [data-forges] *")].filter((el) => !el.closest(".table-scroll"));
    const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase() + "." + el.className);
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, scoped: scope.length, overflowing });
  })()`;
  type Measured = { scrollWidth: number; viewportWidth: number; scoped: number; overflowing: string[] };
  for (const path of ["/forges", "/forges/new?name=" + "n".repeat(38)]) {
    test(`${path.split("?")[0]}: no sideways scroll`, async () => {
      const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${path}`, { width: 390, height: 844 }, [session], measure)) as Measured;
      console.log(`forges ${path.split("?")[0]} 390x844: ${JSON.stringify(m)}`);
      expect(m.scoped).toBeGreaterThan(0);
      expect(m.overflowing).toEqual([]);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
    }, 30_000);
  }
});
