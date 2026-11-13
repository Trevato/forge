/**
 * Rotating, renaming and removing a cloud account from Settings (#7020):
 * the forms post the way the page does, a forge admin only, same-origin
 * only; each answer says what happened and the list shows it; neither the
 * old key nor the new one shows in any page, flash or event; an empty or
 * taken name is refused with the action's words.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, net, removeAccount, reverify } from "../src/actions/cloud.ts";
import { listCloudAccounts } from "../src/core/cloud_account.ts";
import { listEvents } from "../src/core/events.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const T1 = "ghp_first9Zq4TxLm7Kp2Vb8nWcR5";
const T2 = "ghp_second7Hs3DfGj6Lm1Qw0Zx8";
const calls: string[] = [];
net.fetch = async (_url, init) => {
  const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
  calls.push(auth);
  return new Response(JSON.stringify({ login: "octo" }), {
    status: auth.includes(T1) || auth.includes(T2) ? 200 : 401,
  });
};

describe("cloud account forms in Settings", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let member = "";
  const bodies: string[] = [];

  const login = async (username: string) =>
    ((await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  /** Post a form as the page does; `follow` reads the page the redirect lands on, flash included. */
  const post = async (path: string, cookie: string, form: Record<string, string>, origin = servers.url) => {
    const res = await fetch(`${servers.url}/settings/cloud/${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams(form),
    });
    const flashCookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    let page = "";
    if (res.status === 303) {
      page = await (await fetch(`${servers.url}${res.headers.get("location")}`, {
        headers: { cookie: [cookie, flashCookie].filter(Boolean).join("; ") },
      })).text();
      bodies.push(page);
    }
    return { status: res.status, page };
  };
  const names = () => listCloudAccounts(app.db).map((a) => a.name);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cloud-forms-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    admin = await login("alice");
    member = await login("bob");
  });
  /** Every test starts from the same two accounts, both holding T1. */
  beforeEach(async () => {
    for (const a of listCloudAccounts(app.db)) removeAccount(app, aliceUser(), a.provider, a.name);
    for (const name of ["main", "spare"]) expect((await addAccount(app, aliceUser(), "github", name, T1)).ok).toBe(true);
    calls.length = 0;
  });
  /** The key an account actually holds: verify it and see which key the vendor was shown. */
  const heldKey = async (name: string) => {
    calls.length = 0;
    expect((await reverify(app, aliceUser(), "github", name)).ok).toBe(true);
    return calls.at(-1)!;
  };
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const aliceUser = () => getUserByName(app.db, "alice")!;

  const form = (path: string) =>
    path === "rotate" ? { provider: "github", name: "main", value: T2 }
    : path === "rename" ? { provider: "github", name: "main", to: "renamed" }
    : { provider: "github", name: "main" };

  test("a non-admin and a cross-origin post are refused for each, and the account stays", async () => {
    const before = JSON.stringify(listCloudAccounts(app.db));
    for (const path of ["rotate", "rename", "remove"]) {
      expect((await post(path, member, form(path))).status).toBe(403);
      expect((await post(path, admin, form(path), "https://evil.example")).status).toBe(403);
    }
    expect(JSON.stringify(listCloudAccounts(app.db))).toBe(before);
  });

  test("an admin rotates, renames, then removes; each answer says so and the list shows it", async () => {
    const rotated = await post("rotate", admin, form("rotate"));
    expect(rotated.status).toBe(303);
    expect(rotated.page).toContain("Rotated.");
    expect(await heldKey("main")).toContain(T2);

    const renamed = await post("rename", admin, form("rename"));
    expect(renamed.status).toBe(303);
    expect(renamed.page).toContain("Renamed.");
    expect(names()).toContain("renamed");
    expect(names()).not.toContain("main");
    expect(renamed.page).toContain("renamed");
    expect(await heldKey("renamed")).toContain(T2);

    const removed = await post("remove", admin, { provider: "github", name: "renamed" });
    expect(removed.status).toBe(303);
    expect(removed.page).toContain("Removed.");
    expect(names()).not.toContain("renamed");
    expect(removed.page).not.toContain("aria-label=\"Rotate renamed\"");
  });

  test("rotate refuses a key the provider rejects, and an unknown account", async () => {
    const bad = await post("rotate", admin, { provider: "github", name: "spare", value: "ghp_notvalid0000000000000000" });
    expect(bad.page).not.toContain("Rotated.");
    expect(bad.page).toContain('data-tone="danger"');
    expect(bad.page).toContain("The provider did not accept that credential.");
    expect(await heldKey("spare")).toContain(T1);
    const none = await post("rotate", admin, { provider: "github", name: "nope", value: T2 });
    expect(none.page).toContain("No such credential.");
    expect(names().sort()).toEqual(["main", "spare"]);
  });

  test("renaming to an empty name or a taken one is refused with the action's words", async () => {
    const empty = await post("rename", admin, { provider: "github", name: "spare", to: "  " });
    expect(empty.status).toBe(303);
    expect(empty.page).not.toContain("Renamed.");
    expect(empty.page).toContain('data-tone="danger"');
    expect(names().sort()).toEqual(["main", "spare"]);

    const taken = await post("rename", admin, { provider: "github", name: "spare", to: "main" });
    expect(taken.page).toContain("An account has that name already.");
    expect(taken.page).not.toContain("Renamed.");
    expect(names().sort()).toEqual(["main", "spare"]);
  });

  test("neither key shows in any page, flash or event", () => {
    const everything = JSON.stringify(listEvents(app.db, {})) + bodies.join("\n");
    expect(bodies.length).toBeGreaterThan(5);
    expect(everything).not.toContain(T1);
    expect(everything).not.toContain(T2);
  });
});
