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

test("home renders the five tiles; only an admin sees them", async () => {
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

  const a = await home(admin);
  expect(a).toContain('class="kpis"');
  expect((a.match(/class="card kpi"/g) ?? []).length).toBe(5);
  for (const href of ["/board", "/releases", "/boards", "/settings/crew"]) expect(a).toContain(`class="card kpi" href="${href}"`);

  // The figures count every repository, so a non-admin sees none.
  expect(a).toContain("no ceiling");
  expect(await home(bob)).not.toContain('class="kpis"');
  expect(await home()).not.toContain('class="kpis"');
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
    expect(body).toContain("of the daily ceiling");
    expect(body).not.toContain("no ceiling");
  } finally {
    s.stop();
    capped.close();
    await rm(dir, { recursive: true, force: true });
  }
});
