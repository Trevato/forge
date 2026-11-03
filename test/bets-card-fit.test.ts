/**
 * A proposed bet card is bounded at rest (#9240): the preview seed's proposed
 * bets, rendered as their owner, hold one title, the journeys the page
 * allows, one row of actions, no fixed width, and words that wrap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedPreview } from "../src/spawn/preview-seed.ts";
import { PREVIEW_ADMIN, PREVIEW_REPO } from "../src/spawn/preview-looks.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { content } from "../src/web/style/content.ts";
import { SHOWN_JOURNEYS } from "../src/web/pages/bets.ts";

const KEY = "bets-card-fit-key";
let dir: string;
let app: App;
let servers: Servers;
let cards: string[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-bets-fit-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
  const said = `u1|trevato|admin|${Date.now() + 60_000}`;
  const headers = { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
  const html = await (await fetch(`${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/bets`, { headers })).text();
  cards = html.split("<div data-bet-card").slice(1).map((c) => c.slice(0, c.indexOf("Cut it") + 40));
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the owner's bets page, a proposed bet card at rest", () => {
  test("the owner sees both proposed bets of the seed as cards", () => {
    expect(cards.length).toBe(2);
    expect(cards.some((c) => c.includes("Price the list"))).toBe(true);
    expect(cards.some((c) => c.includes("Make every long and winding"))).toBe(true);
  });

  test("one title line", () => {
    for (const c of cards) expect(c.match(/<h2[ >]/g)?.length).toBe(1);
  });

  test("at most the journeys the page allows, the rest behind a disclosure", () => {
    for (const c of cards) {
      const [atRest] = c.split("<details>");
      expect(atRest!.match(/<li>/g)?.length ?? 0).toBeLessThanOrEqual(SHOWN_JOURNEYS);
    }
    const long = cards.find((c) => c.includes("Fifth journey"))!;
    expect(long).toContain("2 more journeys");
    expect(long.split("<details>")[0]!.match(/<li>/g)?.length).toBe(SHOWN_JOURNEYS);
  });

  test("one row of actions, holding back, change the share and cut", () => {
    for (const c of cards) {
      expect(c.match(/data-bet-actions/g)?.length).toBe(1);
      const row = c.slice(c.indexOf("data-bet-actions"));
      expect(row).toContain("Back it at 20%");
      expect(row).toContain("Change the share");
      expect(row).toContain("Cut it");
      expect(c.slice(0, c.indexOf("data-bet-actions"))).not.toContain("<form");
    }
    // What keeps the row inside 390 px: .bar is a flex row that wraps.
    expect(base).toMatch(/^\.bar \{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/m);
  });

  test("no element with a fixed width", () => {
    for (const c of cards) {
      expect(c).not.toMatch(/\swidth=/i);
      expect(c).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
    }
    for (const l of base.split("\n").filter((l) => /^\.bar\b/.test(l))) expect(l).not.toMatch(/(?<![-\w])(?:min-|max-)?width\s*:/);
    const rules = content.split("\n").filter((l) => l.includes("[data-bet-card]"));
    for (const r of rules) expect(r).not.toMatch(/(?<![-\w])width\s*:\s*\d/);
  });

  test("long words wrap", () => {
    expect(content).toMatch(/\[data-bet-card\][^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
