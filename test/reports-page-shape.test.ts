/** The reports pages are headings over rows, not cards (#9761). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { components } from "../src/web/style/components.ts";
import { quietLogs } from "./helpers/globals.ts";
import { statements } from "./helpers/statements.ts";

quietLogs();
let dir = "";
let app: App;
let servers: Servers;
let token = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-reports-shape-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  const made = await createRepo(app, a.value, { name: "game", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  token = createToken(app.db, a.value.id, "t", "rw").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** Statements the warm reports page ran as cards (902f53c7), measured with one report waiting. */
const BUDGET = 35; // +1: the header Talk count (#10327)
const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

test("the queue is a heading over rows, escaped, with its forms and no card", async () => {
  const res = await fetch(`${servers.url}/alice/game/report`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ title: "<b>broken</b>", body: "it <i>fails</i>" }),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const page = await (await fetch(`${servers.url}/alice/game/reports`, { headers: { authorization: `Bearer ${token}` } })).text();
  const m = main(page);
  expect(m).toContain('<section class="settings-block">');
  expect(m).toContain("<h2>Anonymous · 1</h2>");
  expect(m).toContain('<ul class="list setting-list">');
  expect(m).toContain("From outside, anonymous, not checked");
  expect(m).toContain("&lt;b&gt;broken&lt;/b&gt;");
  expect(m).not.toContain("<b>broken");
  expect(m).toMatch(/action="\/alice\/game\/reports\/[^"]+\/accept"/);
  expect(m).toMatch(/action="\/alice\/game\/reports\/[^"]+\/dismiss"/);
  expect(m).not.toContain('class="card');
  expect(m).not.toContain("card-body");
  // Nothing rides in the one-line right-aligned slot; the actions live in the
  // row's own block, accept's button inside its form, dismiss a POST button.
  expect(m).not.toContain("row-after");
  const li = m.slice(m.indexOf("<li"), m.indexOf("</li>"));
  const accept = li.match(/<form[^>]*action="[^"]*\/accept"[^>]*>([\s\S]*?)<\/form>/);
  expect(accept).not.toBeNull();
  expect(accept![1]).toContain('name="title"');
  expect(accept![1]).toMatch(/<button[^>]*>[\s\S]*Accept as an issue/);
  const dismiss = li.match(/<form[^>]*method="post"[^>]*action="[^"]*\/dismiss"[^>]*>([\s\S]*?)<\/form>/);
  expect(dismiss).not.toBeNull();
  expect(dismiss![1]).toMatch(/<button[^>]*>[\s\S]*Dismiss/);
  expect(li).toContain('class="report-body"');
});

test("an empty queue and the sent notice are plain text, not cards", async () => {
  const sent = main(await (await fetch(`${servers.url}/alice/game/report?sent=1`)).text());
  expect(sent).toContain("Report sent");
  expect(sent).not.toContain('class="card');
  const form = main(await (await fetch(`${servers.url}/alice/game/report`)).text());
  expect(form).toContain('action="/alice/game/report"');
  expect(form).not.toContain('class="card');
});

test("a report's body is one shrinkable column: nothing in it can push the page sideways at 390px", () => {
  const rules = [...components.matchAll(/(^|\n)([^\n{}]*\.report-body[^{]*)\{([^}]*)\}/g)].map((m) => ({
    selector: m[2]!.trim(),
    body: m[3]!,
  }));
  const own = rules.find((r) => r.selector === ".report-body");
  expect(own).toBeDefined();
  // A grid's implicit `auto` column grows to its widest child; minmax(0, 1fr)
  // lets it shrink to the viewport, and the children wrap instead.
  expect(own!.body).toContain("display: grid");
  expect(own!.body).toContain("grid-template-columns: minmax(0, 1fr)");
  expect(own!.body).toContain("min-width: 0");
  expect(own!.body).toContain("overflow-wrap: anywhere");
  // Its inset is the row's own 14px, so it lines up under the row title.
  expect(own!.body).toContain("padding: 0 14px 14px");
  // No rule on it sets a fixed width or puts its parts on one flex line.
  for (const r of rules) {
    expect(r.body).not.toMatch(/(^|[;\s])(min-)?width:\s*\d+px/);
    expect(r.body).not.toMatch(/display:\s*(inline-)?flex/);
    expect(r.body).not.toMatch(/white-space:\s*nowrap/);
  }
});

test("the warm reports page runs no more statements than it did as cards", async () => {
  await fetch(`${servers.url}/alice/game/reports`, { headers: { authorization: `Bearer ${token}` } });
  const used = await statements(app.db, async () => {
    const res = await fetch(`${servers.url}/alice/game/reports`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    await res.text();
  });
  expect(used).toBeLessThanOrEqual(BUDGET);
});
