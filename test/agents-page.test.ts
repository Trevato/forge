/**
 * /agents is /llms.txt as a page, for an assistant whose reader takes only
 * HTML: the same words from the same source, each address a link, and the
 * home page's prompt and Open-in links point at it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstSteps, guideHtml, linkAddresses } from "../src/web/pages/agents.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Words above the disclosure: the head, the form and the three steps, measured with a few words of headroom. */
const WORDS_CEILING = 56;

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-agents-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the page is HTML carrying every section of llms.txt, and links back to it", async () => {
  const res = await fetch(`${servers.url}/agents`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/html");
  const page = await res.text();
  const plain = await (await fetch(`${servers.url}/llms.txt`)).text();
  for (const heading of plain.match(/^## .+$/gm) ?? []) expect(page).toContain(`<h2>${heading.slice(3)}</h2>`);
  expect(page).toContain('href="/llms.txt"');
  expect(page).toContain(`<a href="${servers.url}/mcp"`);
  expect(page).toContain("<title>For AI assistants · forge</title>");
});

test("an address becomes a link; code and templates stay as written", () => {
  expect(linkAddresses("See https://a.example/x.")).toBe("See [https://a.example/x](https://a.example/x).");
  expect(linkAddresses("run `curl https://a.example/x`")).toBe("run `curl https://a.example/x`");
  expect(linkAddresses("at https://a.example/{owner}/{name}")).toBe("at https://a.example/{owner}/{name}");
});

test("the home page's prompt and Open-in links point at the page", async () => {
  const home = await (await fetch(`${servers.url}/`)).text();
  expect(home).toContain(`Read ${servers.url}/agents and tell me`);
  expect(home).toContain(encodeURIComponent(`${servers.url}/agents`));
  expect(home).not.toContain("llms.txt%20and");
});

test("a placeholder address is not a link", () => {
  expect(linkAddresses('"page": "https://..."')).toBe('"page": "https://..."');
});

test("the steps are the guide's no-account path, each one line to act on", () => {
  const steps = firstSteps("# t\n\n## Start here\n\nWords.\n\n- Build now, no account: `curl -sX POST https://f.example/api/v1/start -d '{\"name\":\"my-app\"}'` -> {user, claim}. Clone git.url (user:token@), `git push` to main: app.url is live. Give claim.url to the person who takes it over. Unclaimed: asleep in 7 days, archived in 30.\n- Or with an account: x.\n");
  expect(steps).toEqual([
    "`curl -sX POST https://f.example/api/v1/start -d '{\"name\":\"my-app\"}'` -> {user, claim}",
    "Clone git.url (user:token@), `git push` to main: app.url is live",
    "Give claim.url to the person who takes it over",
  ]);
});

test("above the fold the page is the form and three steps; the whole guide is behind one disclosure", async () => {
  const page = await (await fetch(`${servers.url}/agents`)).text();
  const plain = await (await fetch(`${servers.url}/llms.txt`)).text();
  const main = page.slice(page.indexOf("<h1"));
  const open = main.indexOf('<details id="agents-more"');
  expect(open).toBeGreaterThan(0);
  const outside = main.slice(0, open);
  expect(main.match(/<details/g)?.length).toBe(1);
  expect(outside).toContain('action="/forges/start"');
  expect(outside).toContain('href="/llms.txt"');
  // Real list numbering: an <ol> inside .prose, no hand-written "1." in the items.
  const steps = outside.slice(outside.indexOf('<ol id="agent-steps"'));
  expect(outside).toContain('<div class="prose break"><ol id="agent-steps"');
  const items = [...steps.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => m[1]!);
  expect(items.length).toBe(3);
  for (const item of items) expect(item).not.toMatch(/^\s*\d+\./);
  // Each step is the guide's own sentence: the curl, the clone and push, the claim link.
  expect(items[0]).toContain(`<code>curl -sX POST ${servers.url}/api/v1/start`);
  expect(items[1]).toContain("<code>git push</code> to main");
  expect(items[2]).toContain("Give claim.url to the person");
  // Every note-class element, any tag, counted by class token: the page head's subtitle is the only prose.
  const notes = [...outside.matchAll(/class="([^"]*)"/g)].filter((m) => m[1]!.split(/\s+/).some((c) => ["muted", "small", "note", "hint", "why"].includes(c)));
  expect(notes.map((m) => m[1])).toEqual(["page-head-sub muted small"]);
  const words = outside.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
  expect(words).toBeLessThanOrEqual(WORDS_CEILING);
  // The summary's accessible name is its visible text: no aria-label over it.
  expect(main).toMatch(/<summary>\? Full guide<\/summary>/);
  // Inside is /llms.txt word for word: the same Markdown rendered, so a changed word fails.
  const inside = main.slice(open);
  expect(inside).toContain(guideHtml(plain).toString());
  for (const sentence of [
    "Give claim.url to the person who takes it over. Unclaimed: asleep in 7 days, archived in 30.",
    "A hosted forge sleeps when idle and wakes on its next page load, push or API call; on the free plan the person brings their own model credential, or its crew stays off.",
  ]) {
    expect(plain).toContain(sentence);
    expect(inside).toContain(sentence);
  }
  expect(plain.startsWith("# forge at ")).toBe(true);
});
