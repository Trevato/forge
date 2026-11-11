/** The teams list joins the shell's j/k row traversal: one data-nav row per team, each linking to the team's own page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listTeams } from "../src/core/teams.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { teamsLiveJs } from "../src/web/pages/teams.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let bearer = "";

const get = async (path = "/settings/teams"): Promise<Response> =>
  fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-teams-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each team is one data-nav row whose link is that team's own page, and that page answers", async () => {
  const slugs = listTeams(app.db).map((t) => t.slug);
  expect(slugs.length).toBeGreaterThan(0);
  const text = await (await get()).text();
  expect(text.match(/data-nav tabindex="-1"/g)!.length).toBe(slugs.length);
  for (const s of slugs) {
    expect(text).toMatch(new RegExp(`<a href="/settings/teams/${s}"[^>]*data-nav tabindex="-1"`));
    const res = await get(`/settings/teams/${s}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`action="/settings/teams/${s}"`);
  }
  expect((await get("/settings/teams/no-such-team")).status).toBe(404);
});

/** Runs the page's live script against a minimal DOM: the region is redrawn and the row that had focus gets it back. */
function runLive(): { region: { innerHTML: string }; push: (html: string) => void; focusHref: (h: string) => void; focused: () => string | null } {
  type Link = { href: string; getAttribute: (n: string) => string | null; focus: () => void };
  let active: Link | null = null;
  let links: Link[] = [];
  let inner = "";
  const region = {
    get innerHTML() { return inner; },
    set innerHTML(v: string) {
      inner = v;
      links = [...v.matchAll(/<a href="([^"]+)"/g)].map((m) => {
        const link: Link = { href: m[1]!, getAttribute: (n) => (n === "href" ? m[1]! : null), focus: () => { active = link; } };
        return link;
      });
      if (active && !links.includes(active)) active = null; // the old node is gone, as in a browser
    },
    contains: (node: unknown) => links.includes(node as Link),
    querySelectorAll: () => links,
  };
  let listener: ((e: { data: string }) => void) | null = null;
  class FakeEventSource {
    constructor(_url: string) {}
    addEventListener(_kind: string, fn: (e: { data: string }) => void) { listener = fn; }
  }
  const document = {
    getElementById: (id: string) => (id === "teams-cards" ? region : null),
    get activeElement() { return active; },
  };
  new Function("EventSource", "document", teamsLiveJs)(FakeEventSource, document);
  return {
    region,
    push: (html) => listener!({ data: JSON.stringify({ regions: { "teams-cards": html } }) }),
    focusHref: (h) => links.find((l) => l.href === h)!.focus(),
    focused: () => (active ? (active as Link).href : null),
  };
}

const rows = (extra = "") =>
  `<ul><li><a href="/settings/teams/a" data-nav tabindex="-1">a</a></li><li><a href="/settings/teams/b" data-nav tabindex="-1">b${extra}</a></li></ul>`;

test("a live redraw gives focus back to the row that had it", () => {
  const live = runLive();
  live.region.innerHTML = rows();
  live.focusHref("/settings/teams/b");
  live.push(rows(" (changed)"));
  expect(live.region.innerHTML).toContain("(changed)");
  expect(live.focused()).toBe("/settings/teams/b");
});

test("a live redraw does not steal focus when none of its rows had it", () => {
  const live = runLive();
  live.region.innerHTML = rows();
  live.push(rows(" (changed)"));
  expect(live.focused()).toBeNull();
});

// Last: it deletes every team.
test("with no teams the list draws no data-nav", async () => {
  app.db.query("DELETE FROM crew_team_member").run();
  app.db.query("DELETE FROM crew_team").run();
  const navs = (t: string) => (t.match(/\bdata-nav\b/g) ?? []).length;
  const baseline = navs(await (await get("/settings/capacity")).text());
  const text = await (await get()).text();
  expect(navs(text)).toBe(baseline);
  expect(text).not.toContain('href="/settings/teams/');
  expect(text).toContain("No teams yet.");
});
