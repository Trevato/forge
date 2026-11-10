import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { setAccountGrant } from "../src/actions/model_grant.ts";
import { setRole } from "../src/actions/roles.ts";
import { signUp } from "../src/actions/users.ts";
import { GRANT_MAX_USD, getModelGrant } from "../src/core/model_grant.ts";
import { createOrg } from "../src/core/orgs.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("a spend grant: what amount is kept, who takes one", () => {
  let dataDir: string;
  let app: App;
  let admin: User;
  let pat: User;
  const BAD = [-1, 0, 0.001, NaN, Infinity, -Infinity, GRANT_MAX_USD + 0.01];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-grant-amounts-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: "e" });
    const a = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: "a-long-passphrase" });
    if (!a.ok) throw new Error(a.error);
    admin = a.value;
    const b = await seedAdmin(app, { username: "other", email: "other@f.dev", password: "a-long-passphrase" });
    if (!b.ok) throw new Error(b.error);
    const s = await signUp(
      app,
      { username: "pat", email: "pat@f.dev", password: "a-long-passphrase" },
      { slot: fixtureSlot(app) },
    );
    if (!s.ok) throw new Error(s.error);
    proveAll(app);
    pat = getUserByName(app.db, "pat")!;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const stored = (u: User) => getModelGrant(app.db, u.id)?.usdPerMonth;

  test("setAccountGrant keeps a valid amount, refuses a bad one, and null clears", () => {
    const set = setAccountGrant(app, admin, "pat", 12.345);
    expect(set.ok).toBe(true);
    expect(stored(pat)).toBe(12.35);
    for (const usd of BAD) {
      const r = setAccountGrant(app, admin, "pat", usd);
      expect(r).toEqual({ ok: false, error: "invalid_amount" });
      expect(stored(pat)).toBe(12.35);
    }
    expect(setAccountGrant(app, admin, "pat", GRANT_MAX_USD).ok).toBe(true);
    expect(stored(pat)).toBe(GRANT_MAX_USD);
    expect(setAccountGrant(app, admin, "pat", 0.01).ok).toBe(true);
    expect(stored(pat)).toBe(0.01);
    expect(setAccountGrant(app, admin, "pat", null).ok).toBe(true);
    expect(stored(pat)).toBeUndefined();
  });

  test("setRole to member refuses the same amounts and leaves the person a guest with no grant", () => {
    for (const usd of BAD) {
      const r = setRole(app, admin, "pat", "member", usd);
      expect(r).toEqual({ ok: false, error: "invalid_amount" });
      expect(stored(pat)).toBeUndefined();
    }
    const ok = setRole(app, admin, "pat", "member", 7.5);
    expect(ok).toEqual({ ok: true, value: { username: "pat", role: "member", usdPerMonth: 7.5 } });
    expect(stored(pat)).toBe(7.5);
  });

  test("a refused role amount leaves an existing grant unchanged", () => {
    setRole(app, admin, "pat", "guest");
    setAccountGrant(app, admin, "pat", 3);
    for (const usd of BAD) {
      expect(setRole(app, admin, "pat", "member", usd)).toEqual({ ok: false, error: "invalid_amount" });
      expect(stored(pat)).toBe(3);
    }
  });

  test("an agent or an admin takes no grant; an org takes one from an admin but is no member", async () => {
    const bot = await createAgent(app, admin, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    const org = createOrg(app.db, "patco", pat.id);
    if (!org.ok) throw new Error(String(org.error));
    for (const name of ["bot", "other", "olive"]) {
      const user = getUserByName(app.db, name)!;
      expect(setAccountGrant(app, admin, name, 5)).toEqual({ ok: false, error: "not_allowed" });
      expect(setRole(app, admin, name, "member", 5)).toEqual({ ok: false, error: "not_allowed" });
      expect(stored(user)).toBeUndefined();
    }
    expect(setRole(app, admin, "patco", "member", 5)).toEqual({ ok: false, error: "not_found" });
    expect(stored(getUserByName(app.db, "patco")!)).toBeUndefined();
    expect(setAccountGrant(app, admin, "patco", 5).ok).toBe(true);
    expect(stored(getUserByName(app.db, "patco")!)).toBe(5);
    expect(setAccountGrant(app, admin, "nobody", 5)).toEqual({ ok: false, error: "not_found" });
  });

  test("only an admin sets a grant", () => {
    expect(setAccountGrant(app, pat, "pat", 5)).toEqual({ ok: false, error: "not_found" });
    expect(setAccountGrant(app, undefined, "pat", 5)).toEqual({ ok: false, error: "not_found" });
    expect(stored(pat)).toBe(3);
  });
});
