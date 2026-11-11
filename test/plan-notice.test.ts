/**
 * A forge's Plan row (#11141): the host tells each forge its own plan (name,
 * size, status, the public portal URL) and nothing of any other; the row
 * shows it to the forge's admins, in one line, with Manage billing only when
 * a portal URL is set and the forge pays through Stripe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf } from "../src/actions/spawn.ts";
import { changePortalUrl } from "../src/actions/signup.ts";
import { createApp, type App } from "../src/app.ts";
import { noticeOf, tellPlan } from "../src/billing/notice.ts";
import { putEntitlement } from "../src/billing/store.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getPortalUrl } from "../src/settings/billing.ts";
import { planRow, statusWords } from "../src/web/plan_row.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("plan notice", () => {
  let dir: string;
  let app: App;
  let admin: User;
  const PORTAL = "https://billing.stripe.com/p/login/abc123";

  const child = async (name: string): Promise<string> => {
    const bodyId = `body-${name}`;
    await mkdir(join(dir, "spawn"), { recursive: true });
    await writeFile(join(dir, "spawn", `${name}.json`), JSON.stringify({ name, bodyId, done: true, size: "small", org: name, apps: [] }));
    const cd = childDirOf(app, bodyId);
    await mkdir(cd, { recursive: true });
    await writeFile(join(cd, "parent.json"), JSON.stringify({ upstream: "https://host.example" }));
    return cd;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-notice-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("user");
    admin = a.value;
  });
  afterAll(async () => {
    app.close?.();
    await rm(dir, { recursive: true, force: true });
  });

  test("the portal URL is https only, kept for admins, and empty clears it", () => {
    expect(changePortalUrl(app, admin, "http://x.example/").ok).toBe(false);
    expect(changePortalUrl(app, admin, "https://u:p@x.example/").ok).toBe(false);
    expect(changePortalUrl(app, { ...admin, isAdmin: false }, PORTAL)).toEqual({ ok: false, error: "not_found" });
    expect(getPortalUrl(app.db)).toBe("");
    expect(changePortalUrl(app, admin, PORTAL).ok).toBe(true);
    expect(getPortalUrl(app.db)).toBe(PORTAL);
  });

  test("a forge is told its own plan, and only its own; a Stripe payer gets the portal link", async () => {
    const a = await child("alpha");
    const b = await child("beta");
    putEntitlement(app.db, { forge: "alpha", plan: "medium", status: "grace", periodEnd: 1_796_000_000, provider: "stripe", customerId: "cus_secret1", subscriptionId: "sub_secret1", source: "stripe" }, "small", "");
    expect(tellPlan(app, "alpha")).toBe(true);
    const n = noticeOf(a)!;
    expect(n).toMatchObject({ name: "Medium", size: "medium", status: "grace", portalUrl: PORTAL });
    // beta was never told: no call and no file of alpha's reaches it.
    expect(noticeOf(b)).toBeUndefined();
    tellPlan(app, "beta");
    const told = noticeOf(b)!;
    expect(told.name).toBe("Small");
    expect(told.portalUrl).toBeUndefined();
    // Nothing of another forge, nor any provider id, is in what a forge holds.
    for (const d of [a, b]) {
      const raw = await readFile(join(d, "plan.json"), "utf8");
      expect(raw).not.toContain("cus_secret1");
      expect(raw).not.toContain("sub_secret1");
      expect(raw).not.toContain(d === a ? "beta" : "alpha");
    }
    expect(tellPlan(app, "nobody")).toBe(false);
  });

  test("the row is one line for admins only, with the status date and the links", async () => {
    const a = childDirOf(app, "body-alpha");
    const row = planRow(a, "https://host.example", true)!.toString();
    expect(row.split("\n").length).toBe(1);
    expect(row).toContain("<dt>Plan</dt>");
    expect(row).not.toContain(" · ");
    expect(row).toContain("Medium");
    expect(row).toContain("Past due, sleeps 2026-");
    expect(row).toContain(`href="${PORTAL}"`);
    expect(row).toContain('href="https://host.example/pricing"');
    expect(planRow(a, "https://host.example", false)).toBeNull();
    // No portal URL for a forge that does not pay through Stripe: the plan, no link.
    const free = planRow(childDirOf(app, "body-beta"), undefined, true)!.toString();
    expect(free).toContain("Small");
    expect(free).not.toContain("Manage billing");
    expect(free).not.toContain("Change size");
    // A forge told nothing shows no row.
    expect(planRow(join(dir, "nowhere"), undefined, true)).toBeNull();
  });

  test("a hostile notice is refused on read", async () => {
    const cd = childDirOf(app, "body-beta");
    await writeFile(join(cd, "plan.json"), JSON.stringify({ name: "x", size: "small", status: "active", portalUrl: "javascript:alert(1)" }));
    expect(noticeOf(cd)?.portalUrl).toBeUndefined();
    await writeFile(join(cd, "plan.json"), JSON.stringify({ name: "x", size: "small", status: "bogus" }));
    expect(noticeOf(cd)).toBeUndefined();
    expect(statusWords({ status: "active" })).toBe("Active");
  });
});
