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
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

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
