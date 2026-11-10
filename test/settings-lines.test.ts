/**
 * #10999: each setting on a repository's General page is one row — a label,
 * its current value and its control — with its reason in a <details> on that
 * row. Every setting the page had is still a row posting to the same route,
 * and posting that form back to the route changes exactly those settings.
 * Scope: the General page's Branch and gates form; the cloud and secrets
 * sections are lists of rows already (`.setting-list`) and are not touched.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-lines-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "settings-password" });
  await fetch(`${servers.url}/new`, {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ name: "proj", visibility: "private", description: "x" }),
    redirect: "manual",
  });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const KEYS = ["defaultBranch", "protect", "requireReview", "requireChecks", "crewOutsiders", "polishShare"];

test("every setting key is one row inside the form that posts to /settings, reason in a details", async () => {
  const html = await (
    await fetch(`${servers.url}/olive/proj/settings`, { headers: { cookie, accept: "text/html" } })
  ).text();
  const form = gatesForm(html);
  expect(form).not.toBe("");
  for (const key of KEYS) {
    const row = form.match(new RegExp(`<div class="field setting-line" data-setting="${key}">([\\s\\S]*?)</details>`))?.[1];
    expect(row, key).toBeDefined();
    expect(row, key).toContain(`name="${key}"`);
    // Its own reason, on its own row, named for a screen reader and tied to the control.
    expect(row, key).toContain('<details class="hint why"');
    expect(row, key).toContain('aria-label="Why"');
    expect(row, key).toContain(`aria-describedby="why-${key}"`);
    expect(row, key).toContain(`id="why-${key}"`);
    // No stale on/off word: the checkbox is the value.
    expect(row, key).not.toContain("<strong>");
  }
  expect(form.match(/<details/g)?.length).toBe(KEYS.length);
  expect(form).not.toContain('<p class="hint"');
});

/** The names the form posts beside `card=gates` (matched by gatesForm): on main before #10999 they were exactly these. */
const POSTED = ["defaultBranch", "protect", "requireReview", "requireChecks", "crewOutsidersShown", "crewOutsiders", "polishShareShown", "polishShare"];

const page = async (): Promise<string> =>
  (await fetch(`${servers.url}/olive/proj/settings`, { headers: { cookie, accept: "text/html" } })).text();

const post = (fields: Record<string, string>) =>
  fetch(`${servers.url}/olive/proj/settings`, {
    method: "POST",
    headers: { cookie, origin: servers.url },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

const checked = (form: string, key: string): boolean =>
  new RegExp(`name="${key}" [^>]*\\bchecked\\b`).test(form);

test("the form posts the same names to the same route, and each one lands", async () => {
  const before = gatesForm(await page());
  expect([...before.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([...POSTED].sort());
  const branch = /<option value="([^"]+)" selected/.exec(before)?.[1] ?? "";
  expect(branch).not.toBe("");

  const on = { card: "gates", defaultBranch: branch, protect: "on", requireReview: "on", requireChecks: "on", crewOutsidersShown: "1", crewOutsiders: "on", polishShareShown: "1", polishShare: "7" };
  expect((await post(on)).status).toBe(303);
  let form = gatesForm(await page());
  for (const key of ["protect", "requireReview", "requireChecks", "crewOutsiders"]) expect(checked(form, key), key).toBe(true);
  expect(form).toMatch(/name="polishShare"[^>]*value="7"/);

  const off = { card: "gates", defaultBranch: branch, crewOutsidersShown: "1", polishShareShown: "1", polishShare: "0" };
  expect((await post(off)).status).toBe(303);
  form = gatesForm(await page());
  for (const key of ["protect", "requireReview", "requireChecks", "crewOutsiders"]) expect(checked(form, key), key).toBe(false);
  expect(form).toMatch(/name="polishShare"[^>]*value="0"/);
});

function gatesForm(html: string): string {
  return (
    html.match(/<form method="post" action="\/olive\/proj\/settings">\s*<input type="hidden" name="card" value="gates" \/>([\s\S]*?)<\/form>/)?.[1] ?? ""
  );
}
