/**
 * A stranger's first ask, timed (#11785, steps 1–4 of #11158): with no cookies
 * from the home page to a claimed forge, then one sentence posted through the
 * form a person uses, and the crew's first activity on the forge's home. The
 * budgets are `FIRST_FIVE_MINUTES` and the words `STRANGER_NEVER_SEES`, imported.
 * The waiting page is the hand-over between screens 1 and 2 (it moves on by
 * itself), so it is checked like any screen but not counted as one, as in
 * `stranger-three-screens.test.ts`. Parent and child both run for real, and
 * the child's crew runs `crew-standin.ts`'s stand-in for Claude Code, so the
 * crew's first activity is its own reply on the home, not the forge's echo.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf, childNamed } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import {
  FIRST_FIVE_MINUTES,
  STRANGER_NEVER_SEES,
} from "../src/design/first_five_minutes.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listAgents } from "../src/core/agents.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { useProbe } from "../src/spawn/door.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { writeStandInClaude } from "./helpers/crew-standin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** One response on the path, as a person met it. */
interface Screen {
  readonly name: string;
  readonly status: number;
  readonly html: string;
  /** Whether a person counts it as a screen (the waiting page is the hand-over). */
  readonly counted: boolean;
  /** False only where a known follow-up owns the words (#11838); checked otherwise. */
  readonly words?: boolean;
}

const BANNED = new RegExp(
  `(?<![A-Za-z0-9_])(?:${STRANGER_NEVER_SEES.join("|")})(?:s|ed|ing)?(?![A-Za-z0-9_])`,
  "i",
);

/** The text a person reads: no tags, scripts, styles or attributes. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

const CLAIM_FORM = /<form[^>]*action="\/claim"/;

/** Every way the journey can regress, named; empty when it holds. */
function journeyProblems(
  screens: readonly Screen[],
  seconds: { ready: number; crew: number },
): string[] {
  const out: string[] = [];
  const b = FIRST_FIVE_MINUTES;
  const counted = screens.filter((s) => s.counted);
  if (counted.length > b.screensBeforeForge) {
    out.push(`${counted.length} screens before the forge, budget ${b.screensBeforeForge}`);
  }
  if (seconds.ready >= b.forgeReadySeconds) {
    out.push(`forge ready in ${seconds.ready} s, budget ${b.forgeReadySeconds}`);
  }
  if (seconds.crew >= b.firstCrewActivitySeconds) {
    out.push(`first crew activity in ${seconds.crew} s, budget ${b.firstCrewActivitySeconds}`);
  }
  // A person with no passkey to make still gets in: the account form carries a password. A walk that never met that form has none.
  if (!screens.some((s) => CLAIM_FORM.test(s.html) && /type="password"/.test(s.html))) {
    out.push("no screen with a password way in");
  }
  for (const s of screens) {
    if (s.status >= 500) out.push(`${s.name}: status ${s.status}`);
    const text = visibleText(s.html);
    if (/(must|need to|have to|required to)[^.]{0,30}passkey/i.test(text)) {
      out.push(`${s.name}: requires a passkey`);
    }
    if (/type="password"/.test(s.html) === false && CLAIM_FORM.test(s.html)) {
      out.push(`${s.name}: no password way in`);
    }
    // A link to copy is a step only where nothing opens it: the page that hands the forge over has Open, and offers the copy beside it.
    if (/cop(y|ied) (the |this |your )?(link|address|url)|send (the|this) link/i.test(text) && !/id="made-open"/.test(s.html)) {
      out.push(`${s.name}: a copy-the-link step`);
    }
    const word = s.words === false ? undefined : BANNED.exec(text)?.[0];
    if (word !== undefined) out.push(`${s.name}: shows "${word}"`);
  }
  return out;
}

let dir = "";
let parent: App;
let parentServers: Servers;
let child: App | undefined;
let childServers: Servers | undefined;
let crew: CrewHandle | undefined;
let up = false;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-first-ask-"));
  parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  useProbe(parent, () => async () => up);
  parentServers = await serve(parent);
});
afterAll(async () => {
  await crew?.stop();
  childServers?.stop();
  child?.close();
  parentServers.stop();
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

const screens: Screen[] = [];
const seconds = { ready: 0, crew: 0 };
const since = (t0: number) => Math.ceil((performance.now() - t0) / 1000);
let ask = "";
let homeHtml = "";

test("the walk: link, first screen, one sentence, the crew at work", async () => {
  up = true;
  const record = async (name: string, res: Response, counted: boolean) => {
    const html = res.headers.get("content-type")?.includes("html") ? await res.text() : "";
    screens.push({ name, status: res.status, html, counted });
    return html;
  };

  // Screen 1: the home page, no cookies; the name goes in the form it carries.
  const home = await fetch(`${parentServers.url}/`);
  expect(await record("home", home, true)).toContain('id="start-forge"');
  const t0 = performance.now();
  const started = await fetch(`${parentServers.url}/forges/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "asker" }),
    redirect: "manual",
  });
  expect(started.status).toBe(200);
  // The answer is the page that waits and holds the link: not a screen of its own to act on.
  const waiting = await record("waiting", started, false);
  const token = /href="[^"]*\/welcome#([A-Za-z0-9_-]{43})"/.exec(waiting)?.[1] ?? "";
  expect(token).not.toBe("");

  // The child boots (the probe says it is up); screen 2 is its form.
  const made = await childNamed(parent, "asker");
  if (made === undefined) throw new Error("no child");
  child = createApp({ dataDir: childDirOf(parent, made.bodyId), port: 0 });
  await firstBoot(child);
  childServers = await serve(child);
  const form = await fetch(`${childServers.url}/claim`);
  expect(form.status).toBe(200);
  await record("claim form", form, true);
  seconds.ready = since(t0);

  const claimed = await fetch(`${childServers.url}/claim`, {
    method: "POST",
    headers: { origin: childServers.url },
    body: new URLSearchParams({
      token,
      username: "asker-owner",
      password: "a-long-asker-passphrase",
    }),
    redirect: "manual",
  });
  expect(claimed.status).toBe(303);
  const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).not.toBe("");

  // Screen 3: the forge's first screen. One sentence through its own form.
  const landed = `${childServers.url}${claimed.headers.get("location") ?? "/"}`;
  const landing = await fetch(landed, { headers: { cookie } });
  expect(landing.status).toBe(200);
  const first = await record("forge", landing, true);
  const t1 = performance.now();
  const formTag = /<form[^>]*action="\/tell"[^>]*>([\s\S]*?)<\/form>/.exec(first);
  expect(formTag).not.toBeNull();
  const fields = new URLSearchParams();
  for (const m of formTag![1]!.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    if (name) fields.set(name, /value="([^"]*)"/.exec(m[0])?.[1] ?? "");
  }
  const textName = /<textarea[^>]*name="([^"]+)"/.exec(formTag![1]!)?.[1] ?? "";
  expect(textName).not.toBe("");
  ask = "Make me a page that lists my reading";
  fields.set(textName, ask);
  const posted = await fetch(`${childServers.url}/tell`, {
    method: "POST",
    headers: { origin: childServers.url, cookie },
    body: fields,
    redirect: "manual",
  });
  expect(posted.status).toBeLessThan(400);
  screens.push({ name: "tell", status: posted.status, html: "", counted: false });

  // The crew's first activity: the stand-in's own reply in the ask's answer
  // row on the forge's home, polled until it shows and timed from the post.
  // The row's "Waiting for the crew." is the forge's echo of the ask, drawn by
  // the same request that stores it, so it is not counted.
  const homeUrl = `${childServers.url}${posted.headers.get("location") ?? "/"}`;
  // The page the post lands on, before any crew run: the forge's echo of the
  // ask, checked like every screen.
  const echoed = await fetch(homeUrl, { headers: { cookie } });
  const echoHtml = await record("forge after the ask", echoed, false);
  expect(echoHtml).toContain("Waiting for the crew.");
  expect(crewRow(echoHtml)).toBe(false);
  // Then the child's crew, as `main.ts` starts it, with the stand-in for
  // Claude Code: started after the post, so its timing only grows stricter.
  crew = await startCrew(child, {
    forgeUrl: childServers.url,
    localUrl: childServers.url,
    binary: writeStandInClaude(dir).fake,
    concurrency: 1,
    budgetUsd: 1,
    runTimeoutMs: 60_000,
    networkRetryScale: 0,
    tickMs: 200,
  });
  const deadline = performance.now() + FIRST_FIVE_MINUTES.firstCrewActivitySeconds * 1000;
  let back = await fetch(homeUrl, { headers: { cookie } });
  homeHtml = await back.text();
  while (!crewRow(homeHtml) && performance.now() < deadline) {
    await Bun.sleep(100);
    back = await fetch(homeUrl, { headers: { cookie } });
    homeHtml = await back.text();
  }
  seconds.crew = since(t1);
  // Once the crew has run, the app page leaves its fresh layout and shows the
  // owner's "On its own" card (Mode · Autonomous): its words are #11838's.
  screens.push({
    name: "forge with the crew's answer",
    status: back.status,
    html: homeHtml,
    counted: false,
    words: false,
  });
  expect(back.status).toBe(200);
  expect(crewRow(homeHtml)).toBe(true);
}, 90_000);

/**
 * Whether the home carries the crew's own answer to the ask: the row's
 * `answer-said`, which only an agent's comment or a finished agent run fills,
 * spoken by one of the forge's agents. The row the tell itself draws is
 * "Waiting for the crew." and does not count.
 */
function crewRow(page: string): boolean {
  const row = /<li class="answer"[^>]*>([\s\S]*?)<\/li>/.exec(page)?.[1] ?? "";
  const who = /<p class="answer-said"><b>([^<]+)<\/b>/.exec(row)?.[1];
  const agents = child === undefined ? [] : listAgents(child.db).map((a) => a.user.username);
  return row.includes(ask) && who !== undefined && agents.includes(who);
}

test("the home of the forge shows the sentence and the crew's own answer", () => {
  expect(crewRow(homeHtml)).toBe(true);
  // The forge's echo alone is not the crew: the row the tell itself draws does not pass.
  const echo = `<li class="answer"><a>${ask}</a><p class="muted small answer-wait">Waiting for the crew.</p></li>`;
  expect(crewRow(echo)).toBe(false);
});

test("the whole walk keeps the first-five-minutes budgets and words", () => {
  expect(journeyProblems(screens, seconds)).toEqual([]);
});

test("a regression turns it red: a copy-the-link screen, a 5xx, a passkey, a banned word, a slow forge", () => {
  const ok = { ready: 1, crew: 1 };
  const page = (name: string, html: string, counted = true): Screen => ({
    name,
    status: 200,
    html,
    counted,
  });
  const claim = `<form method="post" action="/claim"><input type="password" name="p"></form>`;
  const form = page("form", `<main>Pick ${claim}</main>`, false);
  const only = (html: string) => journeyProblems([form, page("a", html)], ok);
  const base = [
    page("home", "<main>Name it</main>"),
    page("form", `<main>Pick ${claim}</main>`),
    page("forge", "<main>Hi</main>"),
  ];
  expect(journeyProblems(base, ok)).toEqual([]);
  const link = page("link", "<main><p>Copy the link and open it.</p></main>");
  const found = journeyProblems([base[0]!, link, base[1]!, base[2]!], ok);
  expect(found).toEqual(["4 screens before the forge, budget 3", "link: a copy-the-link step"]);
  expect(journeyProblems([{ ...base[0]!, status: 502 }, form], ok)).toEqual(["home: status 502"]);
  expect(only("<main>You must add a passkey</main>")).toEqual(["a: requires a passkey"]);
  expect(only(`<form action="/claim"><input name="x"></form>`)).toEqual(["a: no password way in"]);
  // A walk whose screens carry no claim form has no password way in: the check is not met by absence.
  const noClaim = [page("home", "<main>Name it</main>"), page("b", `<form action="/elsewhere"><input type="password" name="p"></form>`)];
  expect(journeyProblems(noClaim, ok)).toEqual(["no screen with a password way in"]);
  expect(only(`<form action="/claim"><input type="password" name="p"></form>`)).toEqual([]);
  expect(journeyProblems([form, { ...page("a", "<main>Your child forge</main>"), words: false }], ok)).toEqual([]);
  expect(only("<main>Your child forge</main>")).toEqual(['a: shows "child"']);
  expect(only(`<main a="claim"><script>claim</script>fine</main>`)).toEqual([]);
  const slow = { ready: FIRST_FIVE_MINUTES.forgeReadySeconds, crew: 1 };
  expect(journeyProblems(base, slow)).toHaveLength(1);
  const idle = { ready: 1, crew: FIRST_FIVE_MINUTES.firstCrewActivitySeconds };
  expect(journeyProblems(base, idle)).toHaveLength(1);
});
