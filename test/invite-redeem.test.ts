/**
 * An invite link opens the signup door once while signup is `invite`
 * (review L1): the form, the API and the passkey door take the token, the
 * account and the invite's use are one write, and a used, revoked or expired
 * link, or any link while signup is `closed`, makes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listInvites, mintInvite, revokeInvite } from "../src/core/invites.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { setSignup } from "../src/settings/signup.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { device } from "./helpers/passkey.ts";

quietLogs();

const PASSWORD = "an-invited-passphrase";

describe("invite links redeem at signup", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let owner = "";

  const mint = (days = 7, now = Date.now()) => mintInvite(app.db, owner, days, now);
  const stateOf = (id: string) => listInvites(app.db).find((i) => i.id === id)?.state;
  const form = (username: string, invite?: string) =>
    fetch(`${servers.url}/signup${invite === undefined ? "" : `?invite=${invite}`}`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: PASSWORD }),
      redirect: "manual",
    });
  const apiSignup = (username: string, invite?: string) =>
    fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, email: `${username}@f.dev`, password: PASSWORD, ...(invite === undefined ? {} : { invite }) }),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-invite-redeem-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const made = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: PASSWORD });
    if (!made.ok) throw new Error(made.error);
    owner = made.value.id;
    setSignup(app.db, "invite", owner);
    // Many sign-ups from this one source: the window is not under test here.
    setLimit(app.db, "signup.per_source", 1000, owner);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("without a link the door is closed; with one the form is offered", async () => {
    const { token } = mint();
    expect((await fetch(`${servers.url}/signup`)).status).toBe(403);
    const page = await fetch(`${servers.url}/signup?invite=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`invite=${token}`);
    expect((await form("nolink")).status).toBe(403);
    expect(getUserByName(app.db, "nolink")).toBeUndefined();
  });

  test("the form redeems a link once", async () => {
    const { invite, token } = mint();
    expect((await form("ivy", token)).status).toBe(303);
    expect(getUserByName(app.db, "ivy")).toBeDefined();
    // An invite opens the sign-up door, and a sign-up never makes an admin.
    expect(getUserByName(app.db, "ivy")?.isAdmin).toBe(false);
    expect(stateOf(invite.id)).toBe("used");
    const row = app.db.query<{ used_by: string | null }, [string]>("SELECT used_by FROM invite WHERE id = ?1").get(invite.id);
    expect(row?.used_by).toBe(getUserByName(app.db, "ivy")?.id ?? "none");
    expect((await form("ivy2", token)).status).toBe(403);
    expect(getUserByName(app.db, "ivy2")).toBeUndefined();
  });

  test("the API redeems a link once, also when two race for it", async () => {
    const { invite, token } = mint();
    const [a, b] = await Promise.all([apiSignup("race-a", token), apiSignup("race-b", token)]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect(stateOf(invite.id)).toBe("used");
    expect((await apiSignup("race-c", token)).status).toBe(403);
  });

  test("the passkey door redeems a link once", async () => {
    const { invite, token } = mint();
    const post = (path: string, body: Record<string, string>) =>
      fetch(`${servers.url}${path}?invite=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
    const url = new URL(servers.url);
    const keyed = async (username: string) => {
      const options = await post("/signup/passkey/options", { username, email: `${username}@f.dev` });
      const body: unknown = await options.json();
      const challenge = typeof body === "object" && body !== null && "challenge" in body && typeof body.challenge === "string" ? body.challenge : "";
      if (challenge === "") return options.status;
      const d = await device(url.origin, url.hostname);
      return (await post("/signup/passkey", { username, email: `${username}@f.dev`, challenge, ...(await d.create(challenge)) })).status;
    };
    expect(await keyed("pia")).toBe(201);
    expect(stateOf(invite.id)).toBe("used");
    expect(await keyed("pia2")).toBe(403);
  });

  test("a revoked, an expired or an unknown link makes nothing", async () => {
    const revoked = mint();
    revokeInvite(app.db, revoked.invite.id);
    const expired = mint(1, Date.now() - 2 * 86_400_000);
    for (const [name, token] of [["rev", revoked.token], ["exp", expired.token], ["unknown", "invite_nothing"]] as const) {
      expect((await apiSignup(name, token)).status).toBe(403);
      expect(getUserByName(app.db, name)).toBeUndefined();
    }
  });

  test("a taken name does not spend the link", async () => {
    const { invite, token } = mint();
    expect((await apiSignup("ivy", token)).status).not.toBe(201);
    expect(stateOf(invite.id)).toBe("open");
  });

  test("while signup is closed a link makes nothing; while open it is not spent", async () => {
    const { invite, token } = mint();
    setSignup(app.db, "closed", owner);
    expect((await apiSignup("shut", token)).status).toBe(403);
    expect(stateOf(invite.id)).toBe("open");
    setSignup(app.db, "open", owner);
    expect((await apiSignup("opened", token)).status).toBe(201);
    expect(stateOf(invite.id)).toBe("open");
    setSignup(app.db, "invite", owner);
    // Many sign-ups from this one source: the window is not under test here.
    setLimit(app.db, "signup.per_source", 1000, owner);
  });
});
