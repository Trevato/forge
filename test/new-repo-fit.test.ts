/**
 * The new repository form at /new fits a 390 px phone (#9830): seeded with a
 * long owner and a long refused name, it fixes no width over 390 px, wraps
 * anywhere, and (where a Chromium starts) does not scroll sideways.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const LONG = "W".repeat(300);
let dir: string;
let app: App;
let servers: Servers;
let page: string;
let refused: string;
let ownerSeeded = false;
let session: { name: string; value: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-new-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const alice = getUserByName(app.db, "alice")!;
  // An org name this long may be refused at the boundary; then the longest allowed stands in.
  for (const name of [LONG, "o".repeat(100), "o".repeat(39)]) {
    if (createOrg(app.db, name, alice.id).ok) { ownerSeeded = true; break; }
  }
  const cookie = ((await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  session = { name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1) };
  page = await (await fetch(`${servers.url}/new`, { headers: { cookie } })).text();
  refused = await (await fetch(`${servers.url}/new`, { method: "POST", headers: { cookie, origin: servers.url }, body: new URLSearchParams({ owner: "alice", name: `!${LONG}`, description: LONG, visibility: "private" }) })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the /new page at 390 px", () => {
  test("renders the form with a long owner and a long refused value", () => {
    expect(ownerSeeded).toBe(true);
    expect(page).toContain("data-new-repo");
    expect(page).toContain('name="owner"');
    expect(page).toMatch(/<option[^>]*>\s*o{39,}/);
    expect(refused).toContain(`!${LONG}`);
    expect(refused).toContain("data-new-repo");
  });

  test("no inline width, and no rule the page ships fixes a width over 390 px", () => {
    for (const doc of [page, refused]) {
      expect(doc).not.toMatch(/style="[^"]*(?:^|[;\s"])(?:min-)?width\s*:/i);
      for (const m of doc.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    }
    const over: string[] = [];
    for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        const px = Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16);
        if (px > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the page's container wraps anywhere", () => {
    const rule = content.match(/(?:^|\n)([^\n{]*\[data-new-repo\][^\n{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![2]).toMatch(/overflow-wrap:\s*(?:anywhere|break-word)/);
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so the /new phone look is not measured");

describe.skipIf(chromium === undefined)("the /new page, measured at 390x844", () => {
  test("no sideways scroll", async () => {
    const measure = `(() => {
      const vw = document.documentElement.clientWidth;
      const scope = [...document.querySelectorAll("[data-new-repo], [data-new-repo] *")];
      const overflowing = scope.filter((el) => el.getBoundingClientRect().right > vw + 1).slice(0, 8).map((el) => el.tagName.toLowerCase());
      return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, wrapped: scope.length > 0, overflowing });
    })()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/new`, { width: 390, height: 844 }, [session], measure)) as { scrollWidth: number; viewportWidth: number; wrapped: boolean; overflowing: string[] };
    expect(m.wrapped).toBe(true);
    expect(m.overflowing).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
