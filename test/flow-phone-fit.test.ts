/**
 * The owner's /flow page fits a 390 px phone (#9323): a repository with a
 * 300-character unbroken name and many valves ships no fixed width over
 * 390 px, wraps its long text, and (where a Chromium starts) does not
 * scroll sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { findChromium } from "../src/looks/capture.ts";
import { previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";
import { base as elements, utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const KEY = "flow-phone-fit-key";
const WORD = "w".repeat(300);
let dir: string;
let app: App;
let servers: Servers;
let page: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flow-fit-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  const admin = previewAdmin(app)!;
  const repos = app.db.query("SELECT id FROM repo").all() as { id: string }[];
  app.db.query("UPDATE repo SET name = ?1 WHERE id = ?2").run(WORD, repos[0]!.id);
  for (let i = 0; i < 12; i++) {
    const id = `fit-${String(i)}`;
    app.db.query("INSERT INTO repo (id, owner_id, name, created_at) SELECT ?1, owner_id, ?2, created_at FROM repo WHERE id = ?3").run(id, `r${String(i)}-${WORD}`, repos[0]!.id);
    app.db.query("INSERT INTO flow_valve (repo_id, level, set_by, set_at) VALUES (?1, ?2, ?3, ?4)").run(id, 35, admin.id, new Date().toISOString());
  }
  servers = await serve(app);
  const said = `u1|trevato|admin|${Date.now() + 60_000}`;
  const headers = { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
  page = await (await fetch(`${servers.url}/flow`, { headers })).text();
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const widthsOver390 = (css: string): string[] =>
  [...css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)]
    .filter((m) => Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390)
    .map((m) => m[0]);

describe("the owner's flow page at 390 px", () => {
  test("the seeded long content is on the page, in many rows", () => {
    expect(page).toContain(WORD);
    expect(page.match(/class="valve-form"/g)!.length).toBeGreaterThan(10);
  });

  test("no inline width and no rule the page ships fixes a width over 390 px", () => {
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s])min-width\s*:/i);
    const inline = [...page.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
    const sheets = [elements, base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])];
    expect([...inline, ...sheets].flatMap(widthsOver390)).toEqual([]);
  });

  test("the long-text containers wrap anywhere, and a valve's body is not one clipped line", () => {
    expect(content).toMatch(/\.valve-name[^{]*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(content).toMatch(/\.valve-name[^{]*\{[^}]*white-space:\s*normal/);
    expect(content).toMatch(/\.valve-body[^{]*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(content).toMatch(/\.valve-body[^{]*\{[^}]*white-space:\s*normal/);
    expect(page).toContain('class="valve-name"');
    expect(page).toContain('class="valve-body"');
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the flow phone look is not measured");

describe.skipIf(chromium === undefined)("the owner's flow page, measured", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    // The pipes SVG clips its own long labels to its box; the box is what is measured.
    const over = [...document.querySelectorAll("main *")].filter((el) => !el.closest("svg") || el.tagName.toLowerCase() === "svg").filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
    const clipped = [...document.querySelectorAll(".valve-body, .valve-name")].filter((el) => el.scrollWidth > el.clientWidth + 1).length;
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, over, clipped });
  })()`;
  test("phone, 390x844: no sideways scroll", async () => {
    const cookies = [{ name: "forge_session", value: createSession(app.db, previewAdmin(app)!.id).token }];
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/flow`, { width: 390, height: 844 }, cookies, measure)) as { scrollWidth: number; viewportWidth: number; over: string[]; clipped: number };
    console.log(`flow look 390x844: ${JSON.stringify(m)}`);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
    expect(m.over).toEqual([]);
    expect(m.clipped).toBe(0);
  }, 30_000);
});
