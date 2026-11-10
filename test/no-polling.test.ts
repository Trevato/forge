/**
 * No forge page reloads or refetches on a timer, beyond a named allowlist.
 * Pages learn of change from /events; a timer is allowed only where there is
 * no event to hear, and each such file says why here.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "bun:test";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { buildRouter, serve, type Servers } from "../src/http/server.ts";
import { pollJs } from "../src/web/client.ts";
import { adminCookie, seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { pool } from "./helpers/sweep-clock.ts";

quietLogs();

/**
 * The owner's main pages. /crew is not here: it answers 404 for the owner (the
 * crew lives at /<name> and in the feed), so there is no page to render.
 */
const OWNER_PAGES = ["/", "/system", "/flow", "/boards", "/explore", "/forges", "/changelog"];

/** Pages that must hold no timer of any kind, stream or not. */
const NO_TIMER_PAGES = ["/system", "/flow"];

/** Pages that must carry a live stream. /flow is the one named exemption: a form of valves
 *  that only the owner's own submit changes; a pushed patch would move a handle under a drag. */
const STREAM_PAGES = ["/system"];

/** A page as the browser gets it: its markup, and every script it runs (fetched files and inline bodies), apart. */
export interface RenderedPage { html: string; scripts: string[] }

/** A stream a script opens. `data-live` alone, never `data-live-every`, the beat this guard forbids. */
const STREAM = /EventSource\s*\(|data-live(?![-\w])/;

/** Script types that hold data, not code. */
const DATA_SCRIPT = /\btype\s*=\s*["']?application\/(?:ld\+)?json/i;

/**
 * The scripts a page's markup names: each `src`, wherever it sits among the
 * attributes, and each inline body that is code (JSON blocks are data).
 */
export function scriptTags(html: string): { srcs: string[]; inline: string[] } {
  const srcs: string[] = [];
  const inline: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1]!;
    const src = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (src) srcs.push(src[1] ?? src[2] ?? src[3]!);
    else if (!DATA_SCRIPT.test(attrs) && m[2]!.trim() !== "") inline.push(m[2]!);
  }
  return { srcs, inline };
}

/**
 * What a rendered page does that polls. A fetching timer is excused only by a
 * stream opened in the same script, and the pages in NO_TIMER_PAGES and
 * STREAM_PAGES are held to more: a stream page opens its stream in a script.
 */
export function pagePolls(path: string, page: RenderedPage): string[] {
  const found: string[] = [];
  if (/<meta[^>]+http-equiv=["']?refresh/i.test(page.html)) found.push("meta refresh");
  if (/data-live-every/.test(page.html + page.scripts.join("\n"))) found.push("data-live-every");
  for (const code of page.scripts) {
    if (!/setInterval\s*\(/.test(code)) continue;
    if (NO_TIMER_PAGES.includes(path)) found.push("a timer on a page that takes none");
    else if (/fetch\s*\(|location\.reload/.test(code) && !STREAM.test(code)) found.push("setInterval fetch without a live stream in its script");
  }
  if (STREAM_PAGES.includes(path) && !page.scripts.some((code) => STREAM.test(code))) found.push("no live stream in its scripts");
  return found;
}

/**
 * The page as the browser gets it. A same-origin `src` is fetched and read; a
 * script from anywhere else cannot be read here, so it is named, not skipped.
 */
async function render(base: string, path: string, cookie: string): Promise<{ status: number; page: RenderedPage; unread: string[] }> {
  const res = await fetch(base + path, { headers: { cookie } });
  const html = await res.text();
  const { srcs, inline } = scriptTags(html);
  const local = srcs.filter((src) => src.startsWith("/") && !src.startsWith("//"));
  const fetched = await Promise.all(local.map(async (src) => (await fetch(base + src)).text()));
  return { status: res.status, page: { html, scripts: [...fetched, ...inline] }, unread: srcs.filter((src) => !local.includes(src)) };
}

/** file -> the patterns it may carry, and why */
const ALLOWED: Record<string, { allow: string[]; why: string }> = {
  "src/web/sw.ts": { allow: ['http-equiv="refresh"'], why: "the restart page: the forge is down, so there is no /events to hear" },
  "src/web/pages/talk.ts": { allow: ["setInterval"], why: "server side: the stream of one turn watches the run's row, which has no event to hear" },
  "src/web/client.ts": { allow: ["setInterval"], why: "clocks that only redraw text" },
  "src/web/space_client.ts": { allow: ["setInterval"], why: "the map clock label only redraws text; it fetches and reloads nothing" },
};

const PATTERNS: [string, RegExp][] = [
  ["data-live-every", /data-live-every/],
  ["refresh: {", /refresh:\s*\{/],
  ['http-equiv="refresh"', /http-equiv=\\?["']refresh/],
  ["setInterval", /setInterval\s*\(/],
];

/** Names of the patterns a source text trips. */
export function timers(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Files in `files` that trip a pattern and are not allowlisted. */
export function offenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .map(([path, text]) => [path, timers(text).filter((t) => !ALLOWED[path]?.allow.includes(t))] as const)
    .filter(([, hits]) => hits.length > 0)
    .map(([path, hits]) => `${path}: ${hits.join(", ")}`);
}

async function webSources(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const path of new Glob("src/web/**/*.ts").scan(".")) {
    out[path] = await Bun.file(path).text();
  }
  return out;
}

describe("no polling in src/web", () => {
  test("no file outside the allowlist reloads or refetches on a timer", async () => {
    expect(offenders(await webSources())).toEqual([]);
  });

  test("every allowlisted file exists, says why, and still uses what it is allowed", async () => {
    const files = await webSources();
    for (const [path, { allow, why }] of Object.entries(ALLOWED)) {
      expect(path in files).toBe(true);
      expect(why.length).toBeGreaterThan(10);
      for (const p of allow) expect(timers(files[path]!)).toContain(p);
    }
  });

  test("a new timer reload in a fake file turns it red", () => {
    for (const bad of [
      '<p data-live-every="5">',
      "page({ refresh: { seconds: 3 } })",
      '<meta http-equiv="refresh" content="5">',
      "setInterval(() => location.reload(), 1000)",
    ]) {
      expect(offenders({ "src/web/pages/new.ts": bad })).toHaveLength(1);
    }
    expect(offenders({ "src/web/pages/new.ts": "const x = 1;" })).toEqual([]);
    expect(offenders({ "src/web/sw.ts": "http-equiv=\"refresh\"" })).toEqual([]);
    // an allowance covers only its own pattern
    expect(offenders({ "src/web/sw.ts": "setInterval(() => location.reload(), 1)" })).toHaveLength(1);
    expect(offenders({ "src/web/fleet-graph.ts": "refresh: { seconds: 1 }" })).toHaveLength(1);
  });
});

describe("no rendered page polls", () => {
  test("the detector names each kind of polling in a fixture", () => {
    expect(pagePolls("/x", { html: '<meta http-equiv="refresh" content="5">', scripts: [] })).toEqual(["meta refresh"]);
    expect(pagePolls("/x", { html: "<p data-live-every=5>", scripts: [] })).toEqual(["data-live-every"]);
    expect(pagePolls("/x", { html: "", scripts: ["setInterval(() => fetch('/x'), 1000)"] })).toEqual(["setInterval fetch without a live stream in its script"]);
    expect(pagePolls("/x", { html: "", scripts: ["setInterval(() => location.reload(), 1000)"] })).toHaveLength(1);
    // a stream in another script does not excuse the timer
    expect(pagePolls("/x", { html: "", scripts: ["new EventSource('/e')", "setInterval(() => fetch('/x'), 1)"] })).toHaveLength(1);
    // a stream in the same script does; a clock that only redraws text is no poll
    expect(pagePolls("/x", { html: "", scripts: ["new EventSource('/e'); setInterval(() => fetch('/x'), 1)"] })).toEqual([]);
    expect(pagePolls("/x", { html: "", scripts: ["setInterval(() => (el.textContent = now()), 1000)"] })).toEqual([]);
    // /system and /flow take no timer at all, and /system must carry a stream
    expect(pagePolls("/flow", { html: "", scripts: ["setInterval(() => {}, 1)"] })).toEqual(["a timer on a page that takes none"]);
    expect(pagePolls("/system", { html: "", scripts: ["new EventSource('/s')"] })).toEqual([]);
    expect(pagePolls("/system", { html: "", scripts: ["x()"] })).toEqual(["no live stream in its scripts"]);
    // a stream named only in the markup is not a stream /system opens
    expect(pagePolls("/system", { html: "<p>new EventSource('/s')</p>", scripts: ["x()"] })).toEqual(["no live stream in its scripts"]);
    // data-live-every is a beat, not a stream: it excuses no timer
    expect(pagePolls("/x", { html: "", scripts: ["el.dataset['data-live-every']; setInterval(() => fetch('/x'), 1)"] })).toContain("setInterval fetch without a live stream in its script");
    expect(pagePolls("/x", { html: "", scripts: ["q('[data-live]'); setInterval(() => fetch('/x'), 1)"] })).toEqual([]);
    expect(pagePolls("/flow", { html: "", scripts: ["x()"] })).toEqual([]);
  });

  test("every script a page runs is found: src in any attribute position, inline code, not JSON data", () => {
    const html = `<script src="/assets/a.js" defer></script>
      <script defer src="/assets/b.js"></script>
      <script type="module" src='/c.js'></script>
      <script src=https://elsewhere.example/d.js></script>
      <script>setInterval(() => fetch('/x'), 1000)</script>
      <script type="module">import "/e.js"</script>
      <script type="application/json" id="palette-index">{"setInterval(": 1}</script>
      <script type="application/ld+json">{"fetch(": 1}</script>`;
    const { srcs, inline } = scriptTags(html);
    expect(srcs).toEqual(["/assets/a.js", "/assets/b.js", "/c.js", "https://elsewhere.example/d.js"]);
    expect(inline).toEqual(["setInterval(() => fetch('/x'), 1000)", 'import "/e.js"']);
    // an inline poll is caught once read as a script
    expect(pagePolls("/x", { html, scripts: inline })).toEqual(["setInterval fetch without a live stream in its script"]);
    // data-src is not src
    expect(scriptTags('<script data-src="/x.js">go()</script>')).toEqual({ srcs: [], inline: ["go()"] });
  });

  test("the owner's main pages poll nowhere, and /system streams", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-nopoll-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    try {
      const cookie = await adminCookie(app, { username: "lex", email: "o@f.dev", password: "no-polling-pass" });
      const found: string[] = [];
      for (const path of OWNER_PAGES) {
        const { status, page, unread } = await render(servers.url, path, cookie);
        for (const src of unread) found.push(`${path}: a script it cannot read, ${src}`);
        expect(`${path} ${String(status)}`).toBe(`${path} 200`);
        expect(page.scripts.length).toBeGreaterThan(0); // the scripts were read, or the check saw nothing
        for (const hit of pagePolls(path, page)) found.push(`${path}: ${hit}`);
      }
      expect(found).toEqual([]);
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * Every page the router lists (#10947). The owner's pages above are held to
 * more; this walks the whole GET table, signed out and signed in as admin, and
 * reads each page's markup and the scripts it loads.
 */

/** The text of the balanced `(…)` or `{…}` whose opener is at `open`. Strings and comments are not understood: a bracket inside one skews it. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}" };
  const o = src[open]!, c = pairs[o]!;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** The body of a function a script names: `function name(…) {…}` or `name = (…) => {…}` / `name = function (…) {…}`. */
function bodyOf(src: string, name: string): string | undefined {
  const m = new RegExp(`(?:function\\s+${name}\\s*\\(|\\b${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*\\(|\\([^)]*\\)\\s*=>|\\w+\\s*=>))`).exec(src);
  if (!m) return undefined;
  const brace = src.indexOf("{", m.index + m[0].length - 1);
  return brace < 0 ? undefined : balanced(src, brace);
}

/**
 * What a script or page does that polls. Each timer's callback is read whole
 * (balanced to its closing bracket); a named callback is resolved to its body
 * in the same text. A callback built elsewhere (an imported or computed one)
 * cannot be read: that is the detector's limit, pinned in a test below.
 */
export function findPolling(source: string): string[] {
  const found: string[] = [];
  if (/<meta[^>]+http-equiv=["']?refresh/i.test(source)) found.push("meta refresh");
  if (/data-live-every/.test(source)) found.push("data-live-every");
  const re = /\b(setInterval|setTimeout)\s*\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const args = balanced(source, m.index + m[0].length - 1);
    const first = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(args);
    const callback = first ? (bodyOf(source, first[1]!) ?? "") : args;
    if (/location\.reload|location\.replace\(\s*location|history\.go\(\s*0/.test(callback)) found.push(`${m[1]} reloads the page`);
    else if (m[1] === "setInterval" && /\bfetch\s*\(|XMLHttpRequest/.test(callback)) found.push("setInterval fetches");
    // A timeout that asks again is an interval by another name.
    else if (first && /\bfetch\s*\(/.test(callback) && new RegExp(`setTimeout\\(\\s*${first[1]}\\b`).test(callback)) found.push("a fetch re-arms itself on a timeout");
  }
  for (const m of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const body = bodyOf(source, m[1]!) ?? "";
    if (/\bfetch\s*\(/.test(body) && new RegExp(`setTimeout\\(\\s*${m[1]}\\b`).test(body)) found.push("a fetch re-arms itself on a timeout");
  }
  return [...new Set(found)];
}

/**
 * GET patterns the walk cannot fill from its seed, each with why: the walk is
 * every pattern minus these, and the list is checked both ways, so a new page
 * is walked unless someone names it here.
 */
const ORIGIN = "needs a connected origin account; the seed connects none";
const NOT_WALKED: Record<string, string> = {
  "/:owner/-/teams/:team": "needs an organization and a team",
  "/:owner/:name/app/:env/open": "needs a running app environment to open",
  "/:owner/:name/bets/:id": "needs a proposed bet",
  "/:owner/:name/builds/:label/cart": "needs a pinned build with a cart",
  "/:owner/:name/builds/:label/cart.png": "needs a pinned build with a cart",
  "/:owner/:name/builds/:label/shots": "needs a pinned build with pictures",
  "/:owner/:name/builds/:label/shots/:file": "needs a pinned build with pictures",
  "/:owner/:name/commit/:oid": "the seed does not keep the commit id; the commit page is a plain diff with the shell script only",
  "/:owner/:name/looks/:env/:commit/:kind.png": "an image of a captured look, not a page",
  "/:owner/:name/machines/:machine/shell": "needs a running machine to attach a terminal to",
  "/:owner/:name/milestones/:number/limb/:op": "needs a milestone with a limb",
  "/:owner/:name/runs/:id": "the seed creates no run",
  "/:owner/:name/variants/:group": "needs a variant group of agent tries",
  "/:owner/:name/waves/:version": "needs a wave of a milestone",
  "/boards/:slug": "needs a board",
  "/boards/:slug/live": "needs a board; a stream, not a page",
  "/bring/:id/:job": "needs a bring job",
  "/claim/start/:token": "needs the one-time token an anonymous start returned",
  "/fleet/ops/:id": "needs a fleet operation",
  "/go/:code": "needs a short code minted by a share",
  "/home/archived/:op": "needs an archived-home operation",
  "/icons/:spec.png": "an image, not a page",
  "/migrate/jobs/:job": "needs a migration job",
  "/now/:stage": "the stage word is one the seed cannot guess",
  "/resilience/nightly/:job": "needs a nightly job name",
  "/runs/:id": "the seed creates no run",
  "/settings/features/:slug": "needs a feature slug",
  "/settings/origins/:id/archived": ORIGIN,
  "/settings/origins/:id/mirror/:job": ORIGIN,
  "/settings/origins/:id/repos": ORIGIN,
  "/settings/origins/flows/:id": ORIGIN,
  "/settings/origins/flows/:id/stream": ORIGIN,
  "/settings/teams/:slug": "needs a team",
  "/talk/:id": "needs a conversation of the signed-in person",
};
/** The whole browse-an-origin family is one reason. */
const whyNot = (p: string): string | undefined => (p.startsWith("/origins/:id/r/") ? ORIGIN : NOT_WALKED[p]);

describe("every page the router lists", () => {
  let dataDir = "";
  let app: App, servers: Servers;
  let cookie = "";
  const fill: Record<string, string> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-nopoll-walk-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const admin = await seedAdmin(app, { username: "ada", email: "ada@forge.local", password: "correct-horse-battery" });
    if (!admin.ok) throw new Error(admin.error);
    const made = await createRepo(app.db, app.reposRoot, { ownerId: admin.value.id, name: "notes", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const seed = await commitToBranch(app, admin.value, made.value, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] });
    if (!seed.ok) throw new Error(String(seed.error));
    const issue = createIssue(app.db, { repoId: made.value.id, title: "an issue", body: "b", authorId: admin.value.id });
    if (!issue.ok) throw new Error(String(issue.error));
    Object.assign(fill, { owner: "ada", name: "notes", username: "ada", ref: "main", path: "a.txt", number: String(issue.value.number) });
    cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const patterns = (): string[] => [...new Set(buildRouter().routes().filter((r) => r.method === "GET").map((r) => r.pattern))];
  const keysOf = (p: string): string[] => [...p.matchAll(/[:*]([a-z_]+)/g)].map((m) => m[1]!);
  const fillable = (p: string): boolean => keysOf(p).every((k) => k in fill);
  const pathOf = (p: string): string => p.replace(/[:*]([a-z_]+)/g, (_, k: string) => fill[k]!);

  async function walk(headers: Record<string, string>) {
    const scripts = new Map<string, string>();
    const offenders: string[] = [];
    const allowed: string[] = [];
    const htmlPages: string[] = [];
    await pool(patterns().filter(fillable).map(pathOf), async (path) => {
      const res = await fetch(`${servers.url}${path}`, { headers: { "accept-encoding": "identity", ...headers }, redirect: "manual", signal: AbortSignal.timeout(8_000) });
      if (res.headers.get("refresh")) offenders.push(`${path}: Refresh header`);
      if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) { await res.body?.cancel(); return; }
      htmlPages.push(path);
      const html = await res.text();
      for (const found of findPolling(html.replace(/<script\b[^>]*>[^]*?<\/script\s*>/gi, ""))) offenders.push(`${path}: ${found}`);
      const { srcs, inline } = scriptTags(html);
      inline.forEach((code, i) => scripts.set(`${path} inline#${i}`, code));
      for (const src of srcs) if (src.startsWith("/") && !src.startsWith("//") && !scripts.has(src)) scripts.set(src, await (await fetch(`${servers.url}${src}`)).text());
    });
    for (const [name, source] of scripts) {
      const found = findPolling(source);
      if (!found.length) continue;
      offenders.push(`${name}: ${found.join("; ")}`);
    }
    return { htmlPages: htmlPages.sort(), offenders, allowed };
  }

  test("signed out, no page the walk reaches refreshes itself on a timer", async () => {
    const out = await walk({});
    expect(out.offenders).toEqual([]);
    expect(out.htmlPages.length).toBeGreaterThanOrEqual(ANON_FLOOR);
    expect(out.htmlPages).toContain("/");
  }, 30_000);

  test("signed in as admin, no page the walk reaches refreshes itself on a timer", async () => {
    const out = await walk({ cookie });
    expect(out.offenders).toEqual([]);
    expect(out.htmlPages).toContain("/system");
    expect(out.htmlPages).toContain("/flow");
    expect(out.htmlPages.length).toBeGreaterThanOrEqual(WALKED_FLOOR);
  }, 30_000);

  test("the patterns the walk skips are exactly the ones named, each with a reason", () => {
    const skipped = patterns().filter((p) => !fillable(p)).sort();
    expect(skipped.filter((p) => !whyNot(p))).toEqual([]);
    // Every named entry is still skipped: a pattern the seed can now fill must leave the list.
    expect(Object.keys(NOT_WALKED).filter((p) => !skipped.includes(p))).toEqual([]);
    for (const p of skipped) expect(whyNot(p)!.length).toBeGreaterThan(10);
  });
});

/** Fewest HTML pages the admin walk reaches; observed when written. A page lost from the walk drops under it. */
const WALKED_FLOOR = 130;
/** The same, signed out (observed 44). */
const ANON_FLOOR = 40;

describe("the polling detector", () => {
  test("names each kind, including a named callback and a re-arming fetch", () => {
    expect(findPolling(`setInterval(function(){ location.reload(); }, 1000)`)).toContain("setInterval reloads the page");
    expect(findPolling(`setTimeout(function(){ location.reload() }, 5000)`)).toContain("setTimeout reloads the page");
    expect(findPolling(`setInterval(() => fetch("/x").then(r => r.text()), 2000)`)).toContain("setInterval fetches");
    expect(findPolling(`<meta http-equiv="refresh" content="5">`)).toContain("meta refresh");
    expect(findPolling(`<p data-live-every="5">`)).toContain("data-live-every");
    expect(findPolling(`function poll(){ fetch("/x").then(draw); }\nsetInterval(poll, 1000)`)).toContain("setInterval fetches");
    expect(findPolling(`const poll = async () => { await fetch("/x"); };\nsetInterval(poll, 1000)`)).toContain("setInterval fetches");
    expect(findPolling(`function reloadSoon(){ location.reload(); }\nsetTimeout(reloadSoon, 10)`)).toContain("setTimeout reloads the page");
    expect(findPolling(`function ask(){ fetch("/x").then(function(){ setTimeout(ask, 1000); }); }`)).toContain("a fetch re-arms itself on a timeout");
  });

  test("a clean script passes, and a long unrelated callback does not leak into the next timer", () => {
    expect(findPolling(`setInterval(tick, 100); setTimeout(function(){ s.textContent = ''; }, 4000)`)).toEqual([]);
    const filler = "x();".repeat(400);
    expect(findPolling(`setTimeout(function(){ ${filler} }, 1); function later(){ location.reload(); }`)).toEqual([]);
    // a named clock that only redraws text is no poll, even beside a fetch elsewhere
    expect(findPolling(`function tick(){ el.textContent = now(); } setInterval(tick, 1000); function go(){ fetch("/x"); }`)).toEqual([]);
  });

  test("its limit: a callback it cannot read (imported or computed) is not seen", () => {
    expect(findPolling(`import { poll } from "./poll.js"; setInterval(poll, 1000)`)).toEqual([]);
    expect(findPolling(`setInterval(pick("fast"), 1000)`)).toEqual([]);
  });

  test("the device-code page waits on a stream, not a timer", () => {
    expect(findPolling(pollJs)).toEqual([]);
    expect(pollJs).toContain("EventSource");
  });
});
