/**
 * The first-admin code (`core/first_admin.ts`): the operator's way to make
 * the first admin of a forge with none, without a browser in the loop. Minted
 * only by `--first-admin` in the operator's terminal; the forge keeps its
 * hash; it works once, for 15 minutes, and never once a person is admin.
 * Redeemed with a passkey at `/first-admin` or for a scoped token at
 * `POST /api/v1/first-admin`. Ordinary signup still takes a passkey only.
 */

import { insideHiddenDiv } from "./helpers/hidden.ts";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_ADMIN_ORIGIN,
  FIRST_ADMIN_TOKEN_MAX_S,
  FIRST_ADMIN_TOKEN_MIN_S,
  FIRST_ADMIN_TOKEN_TTL_S,
  firstAdminLifetime,
  redeemFirstAdmin,
} from "../src/actions/first_admin.ts";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { APP_TOKEN_TTL_MS } from "../src/apps/token.ts";
import { FIRST_ADMIN_TTL_MS, burnFirstAdmin, mintFirstAdmin, readFirstAdmin } from "../src/core/first_admin.ts";
import { firstAdminCli } from "../src/core/first_admin_cli.ts";
import { listTeamMembers, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { LIFETIMES } from "../src/core/oauth.ts";
import { listPasskeys } from "../src/core/passkeys.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, newAccountsClosed } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setSignup } from "../src/settings/signup.ts";
import { readClaim, spawnedOrg } from "../src/spawn/claim.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";
import { withScripts } from "./helpers/page-script.ts";

quietLogs();

const dirs: string[] = [];
const fresh = async (opts: { url?: string } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "forge-first-admin-"));
  dirs.push(dir);
  return { dir, app: createApp({ dataDir: dir, port: 0, passkeyOnlySignup: true, ...opts }) };
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const redeem = (base: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/v1/first-admin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const admin = (db: App["db"]) =>
  createUser(db, { origin: "seed", trusted: true, username: "operator-made", email: "op@x.test", isAdmin: true });
/** The first-admin token's row: its expiry, as the forge will enforce it. */
const tokenRow = (db: App["db"], tokenId: string) =>
  db.query<{ expires_at: string | null }, [string]>("SELECT expires_at FROM token WHERE id = ?1").get(tokenId)!;

/** Every byte the database holds, as text: where a stored secret would show. */
const everything = (app: App) => Buffer.from(app.db.serialize()).toString("latin1");

describe("the code itself", () => {
  let app: App;
  beforeAll(async () => {
    ({ app } = await fresh());
  });
  afterAll(() => app.close());

  test("is 32 random bytes, and the forge keeps only its sha256", () => {
    const minted = mintFirstAdmin(app.db)!;
    expect(minted.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = app.db.query<{ value: string; updated_by: string }, []>("SELECT value, updated_by FROM forge_setting WHERE key = 'first_admin.code'").get()!;
    expect(JSON.parse(row.value).h).toBe(sha256(minted.code));
    expect(row.updated_by).toBe("operator");
    expect(everything(app)).not.toContain(minted.code);
  });

  test("works once: the second spend is refused", () => {
    const { code } = mintFirstAdmin(app.db)!;
    expect(burnFirstAdmin(app.db, code)).toBe("ok");
    expect(burnFirstAdmin(app.db, code)).toBe("refused");
    expect(readFirstAdmin(app.db, code)).toBe("refused");
  });

  test("dies after 15 minutes", () => {
    const now = Date.now();
    const { code, expiresAt } = mintFirstAdmin(app.db, now)!;
    expect(Date.parse(expiresAt) - now).toBe(FIRST_ADMIN_TTL_MS);
    expect(readFirstAdmin(app.db, code, now + FIRST_ADMIN_TTL_MS - 1)).toBe("ok");
    expect(readFirstAdmin(app.db, code, now + FIRST_ADMIN_TTL_MS)).toBe("refused");
    expect(burnFirstAdmin(app.db, code, now + FIRST_ADMIN_TTL_MS + 1)).toBe("refused");
  });

  test("a newer code replaces the older one", () => {
    const older = mintFirstAdmin(app.db)!.code;
    const newer = mintFirstAdmin(app.db)!.code;
    expect(readFirstAdmin(app.db, older)).toBe("refused");
    expect(readFirstAdmin(app.db, newer)).toBe("ok");
  });

  test("is worth nothing once a person is admin, and cannot be minted then", async () => {
    const { code } = mintFirstAdmin(app.db)!;
    expect((await admin(app.db)).ok).toBe(true);
    expect(readFirstAdmin(app.db, code)).toBe("refused");
    expect(mintFirstAdmin(app.db)).toBeUndefined();
  });
});

describe("headless: POST /api/v1/first-admin", () => {
  let app: App;
  let servers: Servers;
  let code = "";
  beforeAll(async () => {
    ({ app } = await fresh());
    servers = await serve(app);
    code = mintFirstAdmin(app.db)!.code;
  });
  afterAll(() => {
    servers.stop();
    app.close();
  });

  test("ordinary signup still takes a passkey only, even with a live code in the body", async () => {
    const res = await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "eve", email: "eve@x.test", password: "a-long-enough-passphrase", code }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("passkey_required");
    expect(getUserByName(app.db, "eve")).toBeUndefined();
    expect(readFirstAdmin(app.db, code)).toBe("ok");
  });

  test("a refused request spends nothing: no scope, a bad name, a wrong code", async () => {
    expect((await redeem(servers.url, { code, username: "opsbot", email: "bot@x.test" })).status).toBe(422);
    expect((await redeem(servers.url, { code, username: "-opsbot", email: "bot@x.test", scope: "admin" })).status).toBe(422);
    // Refused after the code was spent (a reserved name): it is put back.
    const reserved = await redeem(servers.url, { code, username: "bot", email: "bot@x.test", scope: "admin" });
    expect(((await reserved.json()) as { error: string }).error).toBe("username_reserved");
    const wrong = await redeem(servers.url, { code: "A".repeat(43), username: "opsbot", email: "bot@x.test", scope: "admin" });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: string }).error).toBe("refused");
    expect(readFirstAdmin(app.db, code)).toBe("ok");
    expect(getUserByName(app.db, "opsbot")).toBeUndefined();
  });

  test("a cross-origin request is refused before the code is read", async () => {
    const res = await fetch(`${servers.url}/api/v1/first-admin`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify({ code, username: "opsbot", email: "bot@x.test", scope: "admin" }),
    });
    expect(res.status).toBe(403);
    expect(readFirstAdmin(app.db, code)).toBe("ok");
  });

  test("makes the admin once, with no password and a token of the asked scope", async () => {
    const res = await redeem(servers.url, { code, username: "opsbot", email: "bot@x.test", scope: "rw", name: "agent" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { username: string; isAdmin: boolean };
      scope: string;
      id: string;
      token: string;
      expiresAt: string;
      expiresIn: number;
    };
    expect(body.user).toMatchObject({ username: "opsbot", isAdmin: true });
    expect(body.scope).toBe("rw");
    // Asked for no lifetime: a day, and the forge holds that expiry.
    expect(body.expiresIn).toBe(86_400);
    expect(Math.abs(Date.parse(body.expiresAt) - (Date.now() + 86_400_000))).toBeLessThan(60_000);
    expect(tokenRow(app.db, body.id).expires_at).toBe(body.expiresAt);
    const me = await fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${body.token}` } });
    expect(((await me.json()) as { username: string }).username).toBe("opsbot");
    const row = app.db.query<{ password_hash: string }, []>("SELECT password_hash FROM user WHERE username = 'opsbot'").get()!;
    expect(row.password_hash).toBe("");
    // Once: the same code, any name, is refused.
    const again = await redeem(servers.url, { code, username: "opsbot2", email: "bot2@x.test", scope: "admin" });
    expect(again.status).toBe(403);
    expect(getUserByName(app.db, "opsbot2")).toBeUndefined();
  });

  test("the audit keeps who was made and how; no table holds the code", () => {
    const events = app.db
      .query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'user.created'")
      .all()
      .map((e) => JSON.parse(e.payload) as { via: string; with: string });
    expect(events).toContainEqual(expect.objectContaining({ via: "first-admin", with: "token" }));
    expect(everything(app)).not.toContain(code);
  });
});

describe("the headless token always expires", () => {
  let app: App;
  let servers: Servers;
  let code = "";
  beforeAll(async () => {
    ({ app } = await fresh());
    servers = await serve(app);
    code = mintFirstAdmin(app.db)!.code;
  });
  afterAll(() => {
    servers.stop();
    app.close();
  });

  test("a day by default, as an OAuth token's shortest and an app's token; at most 30 days", () => {
    expect(FIRST_ADMIN_TOKEN_TTL_S).toBe(LIFETIMES["day"]!);
    expect(FIRST_ADMIN_TOKEN_TTL_S * 1000).toBe(APP_TOKEN_TTL_MS);
    expect(FIRST_ADMIN_TOKEN_MAX_S).toBe(LIFETIMES["month"]!);
    expect(firstAdminLifetime(undefined)).toBe(86_400);
    expect(firstAdminLifetime(null)).toBe(86_400);
    expect(firstAdminLifetime(FIRST_ADMIN_TOKEN_MIN_S)).toBe(60);
    expect(firstAdminLifetime(FIRST_ADMIN_TOKEN_MAX_S)).toBe(2_592_000);
  });

  test("never forever, never past the cap: a bad expiresIn is refused and spends nothing", async () => {
    for (const expiresIn of [0, -1, 59, 2_592_001, 1e12, 3600.5, "3600", true, "never", Number.MAX_SAFE_INTEGER]) {
      const res = await redeem(servers.url, { code, username: "opsbot", email: "bot@x.test", scope: "admin", expiresIn });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_expiry");
    }
    expect(getUserByName(app.db, "opsbot")).toBeUndefined();
    expect(readFirstAdmin(app.db, code)).toBe("ok");
  });

  test("a caller's own lifetime is kept, and the token stops working when it lapses", async () => {
    const res = await redeem(servers.url, { code, username: "opsbot", email: "bot@x.test", scope: "admin", expiresIn: 3600 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; token: string; expiresAt: string; expiresIn: number };
    expect(body.expiresIn).toBe(3600);
    expect(Math.abs(Date.parse(body.expiresAt) - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    expect(tokenRow(app.db, body.id).expires_at).toBe(body.expiresAt);
    const me = () => fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${body.token}` } });
    expect((await me()).status).toBe(200);
    // The hour passes.
    app.db.query("UPDATE token SET expires_at = ?1 WHERE id = ?2").run(new Date(Date.now() - 1000).toISOString(), body.id);
    expect((await me()).status).toBe(401);
    // The audit says when it ends.
    const created = app.db
      .query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'token.created'")
      .all()
      .map((e) => JSON.parse(e.payload) as { tokenId: string; expiresAt?: string });
    expect(created).toContainEqual(expect.objectContaining({ tokenId: body.id, expiresAt: body.expiresAt }));
  });

  test("no token the first admin holds lives forever", () => {
    const rows = app.db
      .query<{ expires_at: string | null }, []>(
        "SELECT t.expires_at FROM token t JOIN user u ON u.id = t.user_id WHERE u.username = 'opsbot'",
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.expires_at !== null)).toBe(true);
  });
});

describe("a person: /first-admin with a passkey", () => {
  let app: App;
  let servers: Servers;
  let code = "";
  beforeAll(async () => {
    ({ app } = await fresh());
    servers = await serve(app);
    code = mintFirstAdmin(app.db)!.code;
  });
  afterAll(() => {
    servers.stop();
    app.close();
  });

  test("sign-in links the page only while the forge has no admin", async () => {
    expect(await (await fetch(`${servers.url}/signin`)).text()).toContain('href="/first-admin"');
  });

  test("the page draws the passkey state as a badge, not a passkey-on class", async () => {
    const html = await (await fetch(`${servers.url}/first-admin`)).text();
    expect(html).toContain("Passkey off");
    expect(html).toMatch(/<span\s+class="badge"\s+data-variant="outline"\s*>\s*Passkey off/);
    expect(html).not.toContain("passkey-on");
    expect(html).not.toContain('class="passkey');
    expect(insideHiddenDiv(html, "data-passkey-state")).toBe(false);
  });

  test("the page holds no code and takes it from the fragment", async () => {
    const html = await (await fetch(`${servers.url}/first-admin`)).text();
    expect(html).not.toContain(code);
    expect(await withScripts(servers.url, html)).toContain("location.hash");
    expect(html).toContain('name="token"');
  });

  test("without a key nothing is made or spent", async () => {
    const res = await fetch(`${servers.url}/first-admin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ token: code, username: "ada", email: "ada@x.test", password: "a-long-enough-passphrase" }),
      redirect: "manual",
    });
    expect(res.status).toBe(422);
    const refusedPage = await res.text();
    expect(refusedPage).not.toContain("passkey-note");
    expect(refusedPage).toMatch(/<div class="field"><span class="error" id="passkey-make-note" data-fail="error" role="alert">[^<]+<\/span><\/div>/);
    expect(getUserByName(app.db, "ada")).toBeUndefined();
    expect(readFirstAdmin(app.db, code)).toBe("ok");
  });

  test("with a passkey: the admin is made, signed in, and the code is spent", async () => {
    const who = { token: code, username: "ada", email: "ada@x.test" };
    const res = await fetch(`${servers.url}/first-admin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ ...who, ...(await passkeyFields(servers.url, "/first-admin/options", who)) }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie") ?? "").toContain("forge_session=");
    const ada = getUserByName(app.db, "ada")!;
    expect(ada.isAdmin).toBe(true);
    expect(listPasskeys(app.db, ada.id)).toHaveLength(1);
    expect(readFirstAdmin(app.db, code)).toBe("refused");
    expect(await (await fetch(`${servers.url}/signin`)).text()).not.toContain('href="/first-admin"');
  });
});

describe("nothing the forge logs carries the code", () => {
  test("every line, at debug, through a refusal, a passkey and a token", async () => {
    const { app } = await fresh();
    const servers = await serve(app);
    const lines: string[] = [];
    const level = logLevel();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
    );
    setLogLevel("debug");
    try {
      const { code } = mintFirstAdmin(app.db)!;
      await redeem(servers.url, { code, username: "x", email: "x@x.test", scope: "nope" });
      await fetch(`${servers.url}/first-admin`, { method: "POST", headers: { origin: "https://evil.test" }, body: new URLSearchParams({ token: code }) });
      const who = { token: code, username: "ada", email: "ada@x.test" };
      await passkeyFields(servers.url, "/first-admin/options", who);
      const res = await redeem(servers.url, { code, username: "logged", email: "l@x.test", scope: "admin" });
      expect(res.status).toBe(201);
      const { token } = (await res.json()) as { token: string };
      expect(lines.some((l) => l.includes("first admin made"))).toBe(true);
      expect(lines.join("\n")).not.toContain(code);
      expect(lines.join("\n")).not.toContain(token);
    } finally {
      setLogLevel(level);
      for (const s of spies) s.mockRestore();
      servers.stop();
      app.close();
    }
  });
});

describe("guessing is rate-limited", () => {
  test("an address that keeps trying waits", async () => {
    const { app } = await fresh();
    const servers = await serve(app);
    try {
      mintFirstAdmin(app.db);
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++)
        statuses.push((await redeem(servers.url, { code: "B".repeat(43), username: "x", email: "x@x.test", scope: "ro" })).status);
      expect(statuses.slice(0, 20).every((s) => s === 403)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      servers.stop();
      app.close();
    }
  });
});

describe("the throttle is in the action, so no door can skip it", () => {
  test("calling redeem directly, a guessing address is cut off before the code is read; another address is not", async () => {
    const { app } = await fresh();
    try {
      const { code } = mintFirstAdmin(app.db)!;
      const guess = (address: string, c = "C".repeat(43)) =>
        redeemFirstAdmin(app, { code: c, username: "g", email: "g@x.test", via: "token", address }, () => true);
      const seen: string[] = [];
      for (let i = 0; i < 21; i++) {
        const r = await guess("203.0.113.9");
        seen.push(r.ok ? "ok" : r.error);
      }
      expect(seen.slice(0, 20).every((e) => e === "refused")).toBe(true);
      expect(seen[20]).toBe("rate_limited");
      // Even the right code is refused from the throttled address, and is not spent.
      const blocked = await guess("203.0.113.9", code);
      expect(blocked.ok ? "ok" : blocked.error).toBe("rate_limited");
      expect(readFirstAdmin(app.db, code)).toBe("ok");
      const other = await redeemFirstAdmin(app, { code, username: "fine", email: "f@x.test", via: "token", address: "198.51.100.7" }, () => true);
      expect(other.ok).toBe(true);
      const events = app.db.query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'user.created'").all();
      expect(events.map((e) => (JSON.parse(e.payload) as { via: string }).via)).toEqual([FIRST_ADMIN_ORIGIN]);
    } finally {
      app.close();
    }
  });
});

describe("the signup setting does not hold back the operator", () => {
  test("with signup closed and an account already made, the code still makes the first admin", async () => {
    const { app } = await fresh();
    try {
      const plain = await createUser(app.db, { origin: "seed", trusted: true, username: "plain", email: "p@x.test" });
      if (!plain.ok) throw new Error("plain");
      setSignup(app.db, "closed", plain.value.id);
      expect(newAccountsClosed(app.db)).toBe(true);
      const { code } = mintFirstAdmin(app.db)!;
      const made = await redeemFirstAdmin(app, { code, username: "boss", email: "b@x.test", via: "token", address: "198.51.100.8" }, () => true);
      if (!made.ok) throw new Error(made.error);
      expect(made.value.user.isAdmin).toBe(true);
      expect(getUserByName(app.db, "boss")?.isAdmin).toBe(true);
    } finally {
      app.close();
    }
  });
});

describe("the operator's command: --first-admin", () => {
  test("refuses a data directory with no forge database, and bad flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-first-admin-empty-"));
    dirs.push(dir);
    const none = firstAdminCli([], { FORGE_DATA: dir });
    expect(none.exit).toBe(1);
    expect(none.err[0]).toContain("no forge database");
    expect(firstAdminCli(["--nope"], { FORGE_DATA: dir }).exit).toBe(1);
    expect(firstAdminCli(["--url", "ftp://x"], { FORGE_DATA: dir }).exit).toBe(1);
    expect(firstAdminCli(["--child", "../etc"], { FORGE_DATA: dir }).exit).toBe(1);
  });

  test("beside a running forge: prints a working link at FORGE_URL, then refuses once there is an admin", async () => {
    const { dir, app } = await fresh();
    try {
      const answer = firstAdminCli([], { FORGE_DATA: dir, FORGE_URL: "https://forge.example/" });
      expect(answer.exit).toBe(0);
      const link = answer.out.join("\n").match(/https:\/\/forge\.example\/first-admin#([A-Za-z0-9_-]{43})/);
      expect(link).not.toBeNull();
      // The agent's line names the field, never the code a second time.
      expect(answer.out.filter((l) => l.includes(link![1]!))).toHaveLength(1);
      expect(readFirstAdmin(app.db, link![1]!)).toBe("ok");
      // An admin who can sign in (an admin with no way in is recovered instead: first-admin-recovery.test.ts).
      const made = await admin(app.db);
      if (!made.ok) throw new Error("admin");
      createToken(app.db, made.value.id, "everyday", "rw");
      const refused = firstAdminCli([], { FORGE_DATA: dir });
      expect(refused.exit).toBe(1);
      expect(refused.out).toHaveLength(0);
    } finally {
      app.close();
    }
  });
});

describe("a spawned child, made admin by its parent's operator", () => {
  let parentDir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let childServers: Servers;
  let claimToken = "";

  beforeAll(async () => {
    ({ dir: parentDir, app: parent } = await fresh({ url: "https://forge.test" }));
    const alice = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
    if (!alice.ok) throw new Error("alice");
    const rw = createToken(parent.db, alice.value.id, "rw", "rw").token;
    const repo = await createRepo(parent, alice.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    parentServers = await serve(parent);
    const made = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "maria", apps: ["alice/bakery"], dryRun: false }),
    });
    if (made.status !== 201) throw new Error(`spawn ${made.status} ${await made.text()}`);
    const body = (await made.json()) as { claimUrl: string; bodyId: string };
    claimToken = body.claimUrl.split("#")[1] ?? "";
    child = createApp({ dataDir: childDirOf(parent, body.bodyId), port: 0 });
    childServers = await serve(child);
  }, 30_000);

  afterAll(() => {
    childServers.stop();
    child.close();
    parentServers.stop();
    parent.close();
  });

  test("--child mints in the child's database, at the child's address, and the child's org is handed over", async () => {
    const answer = firstAdminCli(["--child", "maria"], { FORGE_DATA: parentDir, FORGE_URL: "https://forge.test" });
    expect(answer.exit).toBe(0);
    const code = answer.out.join("\n").match(/https:\/\/maria--forge\.test\/first-admin#([A-Za-z0-9_-]{43})/)?.[1];
    expect(code).toBeDefined();
    expect(readFirstAdmin(parent.db, code!)).toBe("refused");
    const res = await redeem(childServers.url, { code: code!, username: "grok", email: "grok@x.test", scope: "admin" });
    expect(res.status).toBe(201);
    const spawned = (await spawnedOrg(child))!;
    const owners = listTeams(child.db, spawned.org.id).find((t) => t.name === OWNERS_TEAM)!;
    const names = listTeamMembers(child.db, owners.id).map((u) => u.username);
    expect(names).toContain("grok");
    expect(names).not.toContain("alice");
    // The claim link now finds an owner, as after a claim.
    expect(readClaim(child.db, spawned.org.id, claimToken).state).toBe("owned");
    expect(firstAdminCli(["--child", "maria"], { FORGE_DATA: parentDir }).exit).toBe(1);
  });
});
