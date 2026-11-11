/**
 * #2908: every limit and capacity setting shows its name, current value,
 * default and control at rest. Nothing waits on hover, and the stylesheet
 * never hides a settings control.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listLimits } from "../src/actions/limits.ts";
import { listCapacity } from "../src/actions/capacity.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { css } from "../src/web/style.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let admin: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-visible-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  admin = r.value;
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string) =>
  (
    await fetch(`${servers.url}${path}`, {
      headers: { cookie: `forge_session=${createSession(app.db, admin.id).token}`, accept: "text/html" },
    })
  ).text();

// The list item of each setting, from its key to the next row.
// A setting row is a list row or, on the denser pages, a table row.
const rowsOf = (page: string) => page.split(/<li>|<tr>/).slice(1);

test("every limit row shows name, value, default, bounds and a control, hover-free", async () => {
  const page = await get("/admin/limits");
  const listed = listLimits(app, admin);
  if (!listed.ok) throw new Error("no limits");
  expect(listed.value.limits.length).toBeGreaterThan(0);
  for (const l of listed.value.limits) {
    const row = rowsOf(page).find((r) => r.includes(`name="key" value="${l.key}"`));
    expect(row, l.key).toBeDefined();
    expect(row).toContain(l.label);
    expect(row).toContain(`Now <span class="mono">${l.value}</span>`);
    expect(row).toContain(`<span class="mono">${l.min}</span>`);
    expect(row).toContain(`<span class="mono">${l.max}</span>`);
    expect(row).toMatch(new RegExp(`<input[^>]*name="value"[^>]*value="${l.value}"`, "s"));
    expect(row).toContain("Save");
    expect(row).not.toContain("row-actions");
  }
});

test("every capacity row shows its value and control, hover-free", async () => {
  const page = await get("/settings/capacity");
  const listed = listCapacity(app, admin);
  if (!listed.ok) throw new Error("no capacity");
  for (const s of listed.value.settings) {
    // a row derived from Speed is read-only: its value, no form
    const mark = s.source === "derived" ? `data-derived="${s.key}"` : `name="key" value="${s.key}"`;
    const row = rowsOf(page).find((r) => r.includes(mark));
    expect(row, s.key).toBeDefined();
    expect(row).toContain(s.label);
    if (s.source !== "derived") expect(row).toContain("Now <span");
    expect(row).not.toContain("row-actions");
  }
});

test("the quota, signup and invite forms are not hover-gated", async () => {
  const page = await get("/admin/limits");
  for (const action of ["/admin/quotas", "/admin/signup", "/admin/invites"]) {
    const form = page.match(new RegExp(`<form[^>]*action="${action}"[^>]*>`))?.[0];
    expect(form, action).toBeDefined();
    expect(form).not.toContain("row-actions");
  }
});

test("the stylesheet never hides settings controls", () => {
  const rules = (css as string).split("}");
  const mine = rules.filter((r) => /\.row-fields|\.setting-list/.test(r));
  expect(mine.length).toBeGreaterThan(0);
  for (const r of mine) {
    expect(r).not.toMatch(/opacity:\s*0\b/);
    expect(r).not.toContain("content-visibility");
    expect(r).not.toMatch(/visibility:\s*hidden/);
  }
  expect(mine.join("}")).toMatch(/\.setting-list \.row-meta[^}]*white-space:\s*normal/);
});

// #2918: the primary control of every other settings row is visible at rest too.
test("settings pages keep their primary forms out of .row-actions", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of ["flags", "telemetry", "people", "cloud", "access"]) {
    const src = await readFile(join(import.meta.dir, "..", "src/web/pages", `${f}.ts`), "utf8");
    expect(src, f).not.toContain("row-actions");
    expect(src, f).toContain("row-fields");
  }
  const subs = await readFile(join(import.meta.dir, "..", "src/web/pages/subscriptions.ts"), "utf8");
  expect(subs).not.toMatch(/headroom row-actions/);
  const flags = await get("/settings/flags");
  expect(flags).not.toContain("row-actions");
});
