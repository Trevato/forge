/**
 * DESIGN.md rule 2 (#10998): /crew and /flow answer at first sight. The notes
 * they render (any tag, `note:` props included, outside the `?` help) are at
 * least halved from main's, and pinned there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";
import { renderedNotes, words } from "./helpers/rendered-notes.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-notes-ceiling-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.test", adminIfFirst: true });
  if (!made.ok) throw new Error(String(made.error));
  promote(app.db, made.value);
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const bot = await createAgent(app, made.value, { username: "bot", brief: "Be brief." });
  if (!bot.ok) throw new Error(String(bot.error));
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const crewPage = async (): Promise<string> => {
  const res = await fetch(`${servers.url}/settings/crew`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
};
const flowPage = (): string => String(flowPanel(app, { kind: "owner" }, new URL("http://x/boards"), "/boards"));

test("the counter sees a note whatever its tag, and not what sits behind ?", () => {
  expect(renderedNotes('<p class="muted">Nothing queued in the hour.</p><span class="hint">Nothing queued in the hour.</span>')).toHaveLength(2);
  expect(renderedNotes('<span class="stat-note">from the last 28 days</span>')).toHaveLength(1);
  expect(renderedNotes('<td class="num muted">—</td><span class="muted">default</span>')).toHaveLength(0);
  expect(renderedNotes('<details class="disclosure" data-page-help><summary>?</summary><p class="muted">Each one of these words</p></details>')).toHaveLength(0);
  expect(words("a run on <b>it</b>, an open pull")).toBe(6);
});

// The same fixture on main renders 10 notes on /crew and 20 on /flow.
test("/crew renders at most 3 notes", async () => {
  expect(renderedNotes(await crewPage()).length).toBeLessThanOrEqual(3);
});

test("/flow renders at most 10 notes", () => {
  expect(renderedNotes(flowPage()).length).toBeLessThanOrEqual(10);
});

test("what moved is behind each page's ?, so no explanation is lost", async () => {
  const help = (page: string): string => page.match(/<details[^>]*data-page-help[\s\S]*?<\/details>/)?.[0] ?? "";
  const crew = help(await crewPage());
  for (const t of ["Dials for the crew", "Over the pulls each agent opened", "At most one change of model", "the first half of its branch names", "names the newest of its line"])
    expect(crew).toContain(t);
  const flow = help(flowPage());
  for (const t of ["Green, approved pulls join", "check.verify", "first filter that holds", "Checks queued to start", "/settings/capacity", "/resilience", "/contribute"])
    expect(flow).toContain(t);
});

test("the hints that steer a choice stay at the field they explain", async () => {
  const page = await crewPage();
  const roles = page.slice(page.indexOf('id="agent-roles"'), page.indexOf("</fieldset>", page.indexOf('id="agent-roles"')));
  expect(roles).toContain("A repository's team lists offer it only");
  expect(page).toContain("0 uses the forge&#39;s default");
  expect(page).toContain("appended to the prompt of every run");
});

test("the ? is the one place a stage's meaning lives: no hover-only title on /flow's stage names or the ? itself", async () => {
  const flow = flowPage();
  expect(flow).toContain('data-stage="');
  expect(flow).not.toMatch(/<th scope="row"[^>]*title=/);
  for (const page of [flow, await crewPage()]) {
    const summary = page.match(/<details[^>]*data-page-help[^>]*>\s*<summary[^>]*>/)?.[0] ?? "";
    expect(summary).toContain("<summary");
    expect(summary).not.toContain("title=");
  }
});

test("the ? the pages render is a 44×44 px target with a visible focus ring, at 360 px too", async () => {
  // The stylesheet as served, every layer and @media block included.
  const { css } = await import("../src/web/style.ts");
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: (selector ?? "").trim(),
    body: body ?? "",
  }));
  const declared = (selector: string): string =>
    rules.filter((r) => r.selector.split(",").some((s) => s.trim() === selector)).map((r) => r.body).join(";");
  for (const page of [flowPage(), await crewPage()]) {
    const details = page.match(/<details[^>]*data-page-help[^>]*>/)?.[0] ?? "";
    expect(details).toMatch(/class="[^"]*\bdisclosure\b/);
  }
  expect(declared(".disclosure > summary")).toContain("min-height: 44px");
  expect(declared(".disclosure[data-page-help] > summary")).toContain("min-width: 44px");
  expect(declared(".disclosure[data-page-help] > summary:focus-visible")).toMatch(/outline: 2px solid var\(--accent\)/);
  // Nothing anywhere, a narrow-screen block included, takes either back.
  const reaches = (selector: string): boolean =>
    /\bsummary\b/.test(selector) && (/^summary\b/.test(selector) || /disclosure|data-page-help/.test(selector));
  for (const { selector, body } of rules.filter((r) => reaches(r.selector))) {
    expect(`${selector} { ${body} }`).not.toMatch(/min-(?:height|width):\s*(?:[0-3]?\d|4[0-3])(?:\.\d+)?px|outline:\s*(?:none|0)\b|max-(?:height|width):\s*\d/);
  }
});
