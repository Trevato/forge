/** The figures row on the real home (#2871): an admin's links, a non-admin's, and where it is not. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-home-kpi-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("home renders the eight tiles; only an admin sees them", async () => {
  const mk = async (username: string, first = false): Promise<User> => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  const admin = await mk("keeper", true);
  const bob = await mk("bob");
  const home = async (u?: User) =>
    (
      await fetch(`${servers.url}/`, {
        headers: u ? { cookie: `forge_session=${createSession(app.db, u.id).token}; forge_mode=studio` } : {},
      })
    ).text();

  // Seeded reach: 4 page views by 3 visitors today, 1 yesterday; sessions seen today.
  const day = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const view = (d: string, visitor: string, load: number | null, inp: number | null) =>
    app.db.run("INSERT INTO page_vital (day, at, route, visitor, ttfb, load, lcp, inp, cls) VALUES (?, ?, '/', ?, 10, ?, 100, ?, 0)", [d, Date.now(), visitor, load, inp]);
  view(day, "a", 100, 40);
  view(day, "b", 200, 80);
  view(day, "c", 300, 120);
  view(day, "a", 1900, null);
  view(yesterday, "z", 400, 160);
  const a = await home(admin);
  expect(a).toContain('class="stats kpi-row mb"');
  expect((a.match(/class="stat"/g) ?? []).length).toBe(8);
  for (const href of ["/board", "/releases", "/boards", "/settings/crew", "/settings/backups"]) expect(a).toContain(`class="stat" href="${href}"`);
  // The tiles are §5 stats (#3982): none of the page-local kpi classes is left on home.
  for (const name of ["kpis", "kpi", "kpi-value", "kpi-note", "kpi-spark"]) expect(a).not.toMatch(new RegExp(`class="[^"]*\\b${name}\\b(?!-)`));
  expect(a).toContain('role="img" aria-label="Shipped each hour over the last 24 hours"');

  // 2 accounts, the admin alone with a session today; visitors 3 today and 4 over 7 days;
  // load p75 of [100,200,300,400,1900] is 400 ms, INP p75 of [40,80,120,160] is 120 ms.
  expect(a).toContain(">400 ms<");
  expect(a).toContain(">reacts in 120 ms<");
  expect((a.match(/class="stat" href="\/boards\/reach"/g) ?? []).length).toBe(1);

  // The figures count every repository, so a non-admin sees none.
  expect(a).toContain("no forge ceiling");
  expect(await home(bob)).not.toContain('class="stats kpi-row mb"');
  expect(await home(bob)).not.toContain("last 30 days");
  expect(await home()).not.toContain('class="stats kpi-row mb"');
  expect(await home()).not.toContain("last 30 days");
});

test("home passes the forge's daily ceiling to the spend tile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-home-kpi-cap-"));
  const capped = createApp({ dataDir: dir, port: 0, crewCeilingUsd: 40 });
  const s = await serve(capped);
  try {
    const r = await createUser(capped.db, {
      origin: "seed",
      trusted: true,
      username: "keeper",
      email: "keeper@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!r.ok) throw new Error(r.error);
    promote(capped.db, r.value);
    const res = await fetch(`${s.url}/`, {
      headers: { cookie: `forge_session=${createSession(capped.db, r.value.id).token}; forge_mode=studio` },
    });
    const body = await res.text();
    expect(body).toContain("of $40");
    expect(body).toContain("of the forge ceiling");
    expect(body).not.toContain("no forge ceiling");
  } finally {
    s.stop();
    capped.close();
    await rm(dir, { recursive: true, force: true });
  }
});
