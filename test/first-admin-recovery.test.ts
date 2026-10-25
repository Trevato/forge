/**
 * First-admin recovery (`core/first_admin.ts`): a forge whose admins have no
 * working credential left — no password, no passkey, no unexpired token (and
 * no live session, SSH key or sign-in with the parent) — is locked out,
 * typically a headless first admin whose expiring token lapsed. The operator
 * runs `--first-admin` again and gets a recovery code: single use, 15
 * minutes, kept only as a hash, redeemed at `POST /api/v1/first-admin/recover`
 * for a new expiring token for that existing admin. No account is made. It is
 * refused while any admin can still sign in.
 */

import { afterAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { firstAdminCli } from "../src/core/first_admin_cli.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

// Each test boots a database and, for the HTTP ones, a listener. That is tens of
// milliseconds alone but passed 5 s on a check machine running many suites at once
// (seen: "timed out after 5000ms"), so the budget is for the boot, not the code.
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// One instant for the file: expiries are built from it and the CLI is asked at it,
// so a slow machine cannot move a "future" expiry into the past between the two.
const NOW = Date.now();
const past = () => new Date(NOW - 86_400_000).toISOString();
const future = () => new Date(NOW + 3_600_000).toISOString();
const CODE = /"code": "([A-Za-z0-9_-]{43})"|#([A-Za-z0-9_-]{43})|\b([A-Za-z0-9_-]{43})\b/;

/** A forge with one admin and no credential at all: the shape a lapsed headless admin leaves. */
async function stranded(name = "opsbot", listen = true): Promise<{ dir: string; app: App; servers: Servers; userId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "forge-first-admin-recovery-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0, passkeyOnlySignup: true });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@x.test`, isAdmin: true });
  if (!made.ok) throw new Error("user");
  // Its token from the first-admin redemption, lapsed.
  createToken(app.db, made.value.id, "first-admin", "admin", { expiresAt: past() });
  // The CLI reads the database file alone; only the HTTP tests need a listener.
  const servers = listen ? await serve(app) : { url: "", stop: () => {} };
  return { dir, app, servers: servers as Servers, userId: made.value.id };
}

const post = (base: string, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const recover = (base: string, body: Record<string, unknown>) => post(base, "/api/v1/first-admin/recover", body);
const codeOf = (out: readonly string[]): string => {
  const m = out.join("\n").match(CODE);
  if (!m) throw new Error(`no code in ${out.join("\n")}`);
  return (m[1] ?? m[2] ?? m[3])!;
};
const users = (app: App) => app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM user").get()!.n;
const everything = (app: App) => Buffer.from(app.db.serialize()).toString("latin1");

describe("a forge whose only admin has no working credential", () => {
  test("the operator gets a recovery code, and it mints a new expiring token for that admin, once", async () => {
    const { dir, app, servers } = await stranded();
    try {
      const before = users(app);
      const answer = firstAdminCli([], { FORGE_DATA: dir, FORGE_URL: "https://forge.example" });
      expect(answer.err).toEqual([]);
      expect(answer.exit).toBe(0);
      expect(answer.out.join("\n")).toContain("https://forge.example/api/v1/first-admin/recover");
      expect(answer.out.join("\n")).toContain("opsbot");
      const code = codeOf(answer.out);
      expect(answer.out.filter((l) => l.includes(code))).toHaveLength(1);
      // Only its hash is kept.
      expect(everything(app)).not.toContain(code);
      expect(everything(app)).toContain(sha256(code));

      const res = await recover(servers.url, { code, scope: "admin", expiresIn: 3600 });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        user: { username: string; isAdmin: boolean };
        id: string;
        token: string;
        scope: string;
        expiresAt: string;
        expiresIn: number;
      };
      expect(body.user).toMatchObject({ username: "opsbot", isAdmin: true });
      expect(body.scope).toBe("admin");
      expect(body.expiresIn).toBe(3600);
      const row = app.db
        .query<{ expires_at: string | null; user_id: string }, [string]>("SELECT expires_at, user_id FROM token WHERE id = ?1")
        .get(body.id)!;
      expect(row.expires_at).toBe(body.expiresAt);
      expect(row.user_id).toBe(getUserByName(app.db, "opsbot")!.id);
      const me = await fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${body.token}` } });
      expect(((await me.json()) as { username: string }).username).toBe("opsbot");
      // No account was made.
      expect(users(app)).toBe(before);
      // Audited as a recovery, with no secret in the record.
      const events = app.db.query<{ kind: string; payload: string }, []>("SELECT kind, payload FROM event").all();
      const recovered = events.filter((e) => (JSON.parse(e.payload) as { via?: string }).via === "first-admin-recovery");
      expect(recovered.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(code);
      expect(JSON.stringify(events)).not.toContain(body.token);
      // Once.
      expect((await recover(servers.url, { code, scope: "admin" })).status).toBe(403);
      // And now the admin can sign in again, so no further code is made.
      const again = firstAdminCli([], { FORGE_DATA: dir });
      expect(again.exit).toBe(1);
      expect(again.out).toHaveLength(0);
    } finally {
      servers.stop();
      app.close();
    }
  });

  test("the recovered token always expires: a day by default, never past 30 days", async () => {
    const { dir, app, servers } = await stranded();
    try {
      const code = codeOf(firstAdminCli([], { FORGE_DATA: dir }).out);
      for (const expiresIn of [0, 59, 2_592_001, "3600", 1.5]) {
        const res = await recover(servers.url, { code, scope: "rw", expiresIn });
        expect(res.status).toBe(422);
      }
      expect((await recover(servers.url, { code, scope: "root" })).status).toBe(422);
      // Those spent nothing.
      const res = await recover(servers.url, { code, scope: "rw" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expiresIn: number; expiresAt: string };
      expect(body.expiresIn).toBe(86_400);
      expect(Math.abs(Date.parse(body.expiresAt) - (Date.now() + 86_400_000))).toBeLessThan(60_000);
    } finally {
      servers.stop();
      app.close();
    }
  });

  test("dies after 15 minutes", async () => {
    const { dir, app, servers } = await stranded();
    try {
      const code = codeOf(firstAdminCli([], { FORGE_DATA: dir }, Date.now() - 15 * 60_000 - 1000).out);
      expect((await recover(servers.url, { code, scope: "rw" })).status).toBe(403);
    } finally {
      servers.stop();
      app.close();
    }
  });

  test("a recovery code makes no account, and a first-admin code recovers nobody", async () => {
    const { dir, app, servers } = await stranded();
    try {
      const code = codeOf(firstAdminCli([], { FORGE_DATA: dir }).out);
      const made = await post(servers.url, "/api/v1/first-admin", { code, username: "intruder", email: "i@x.test", scope: "admin" });
      expect(made.status).toBe(403);
      expect(getUserByName(app.db, "intruder")).toBeUndefined();
      // The same code still recovers: the wrong door spent nothing.
      expect((await recover(servers.url, { code, scope: "rw" })).status).toBe(201);
    } finally {
      servers.stop();
      app.close();
    }
    // A forge with no admin: its code is a first-admin code, and /recover refuses it.
    const dir2 = await mkdtemp(join(tmpdir(), "forge-first-admin-recovery-none-"));
    dirs.push(dir2);
    const app2 = createApp({ dataDir: dir2, port: 0, passkeyOnlySignup: true });
    const servers2 = await serve(app2);
    try {
      const code = codeOf(firstAdminCli([], { FORGE_DATA: dir2 }).out);
      expect((await recover(servers2.url, { code, scope: "admin" })).status).toBe(403);
    } finally {
      servers2.stop();
      app2.close();
    }
  });

  test("refused cross-origin, and guessing is rate-limited", async () => {
    const { dir, app, servers } = await stranded();
    try {
      const code = codeOf(firstAdminCli([], { FORGE_DATA: dir }).out);
      const cross = await post(servers.url, "/api/v1/first-admin/recover", { code, scope: "rw" }, { origin: "https://evil.example" });
      expect(cross.status).toBe(403);
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++)
        statuses.push((await recover(servers.url, { code: "A".repeat(43), scope: "rw" })).status);
      expect(statuses.slice(0, 20).every((s) => s === 403)).toBe(true);
      expect(statuses[20]).toBe(429);
      // Even the right code waits, from a throttled address.
      expect((await recover(servers.url, { code, scope: "rw" })).status).toBe(429);
    } finally {
      servers.stop();
      app.close();
    }
  });
});

describe("nothing the forge logs carries a recovery code or its token", () => {
  test("every line, at debug, through a refusal and a recovery", async () => {
    const { dir, app, servers } = await stranded();
    const lines: string[] = [];
    const level = logLevel();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
    );
    setLogLevel("debug");
    try {
      const code = codeOf(firstAdminCli([], { FORGE_DATA: dir }).out);
      await recover(servers.url, { code, scope: "nope" });
      await post(servers.url, "/api/v1/first-admin/recover", { code, scope: "rw" }, { origin: "https://evil.test" });
      const res = await recover(servers.url, { code, scope: "admin" });
      expect(res.status).toBe(201);
      const { token } = (await res.json()) as { token: string };
      expect(lines.some((l) => l.includes("stranded admin recovered"))).toBe(true);
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

describe("refused while any admin has a working credential", () => {
  type Give = (app: App, userId: string) => void;
  const credentials: Record<string, Give> = {
    "a password": (app, id) => {
      app.db.query("UPDATE user SET password_hash = 'argon2id$x' WHERE id = ?1").run(id);
    },
    "a passkey": (app, id) => {
      app.db
        .query("INSERT INTO passkey (id, user_id, credential_id, name, alg, key) VALUES (?1, ?2, ?3, 'key', 'ES256', '{}')")
        .run(`pk-${id}`, id, `cred-${id}`);
    },
    "an unexpired token": (app, id) => {
      createToken(app.db, id, "live", "ro", { expiresAt: future() });
    },
    "a token that never expires": (app, id) => {
      createToken(app.db, id, "forever", "ro");
    },
    "a live session": (app, id) => {
      app.db
        .query("INSERT INTO session (token_hash, user_id, expires_at, id) VALUES (?1, ?2, ?3, ?4)")
        .run(sha256(`s-${id}`), id, future(), `sess-${id}`);
    },
    "an SSH key": (app, id) => {
      app.db
        .query("INSERT INTO user_key (id, user_id, name, algo, blob, fingerprint) VALUES (?1, ?2, 'k', 'ssh-ed25519', 'AAAA', ?3)")
        .run(`uk-${id}`, id, `SHA256:${id}`);
    },
    "sign-in with the parent": (app, id) => {
      app.db
        .query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES ('https://parent.test', ?1, ?2)")
        .run(`sub-${id}`, id);
    },
  };

  for (const [what, give] of Object.entries(credentials)) {
    test(`the stranded admin itself, or another admin, has ${what}`, async () => {
      const { dir, app, servers, userId } = await stranded("opsbot", false);
      try {
        give(app, userId);
        expect(firstAdminCli([], { FORGE_DATA: dir }, NOW).exit).toBe(1);
      } finally {
        servers.stop();
        app.close();
      }
      const other = await stranded("opsbot", false);
      try {
        const second = await createUser(other.app.db, { origin: "seed", trusted: true, username: "second", email: "s@x.test", isAdmin: true });
        if (!second.ok) throw new Error("second");
        give(other.app, second.value.id);
        const refused = firstAdminCli([], { FORGE_DATA: other.dir }, NOW);
        expect(refused.exit).toBe(1);
        expect(refused.out).toHaveLength(0);
      } finally {
        other.servers.stop();
        other.app.close();
      }
    });
  }

  test("an expired session and an expired token are not working credentials", async () => {
    const { dir, app, servers, userId } = await stranded("opsbot", false);
    try {
      app.db
        .query("INSERT INTO session (token_hash, user_id, expires_at, id) VALUES (?1, ?2, ?3, ?4)")
        .run(sha256("old"), userId, past(), "sess-old");
      expect(firstAdminCli([], { FORGE_DATA: dir }, NOW).exit).toBe(0);
    } finally {
      servers.stop();
      app.close();
    }
  });

  test("a credential that appears after the code is minted kills it", async () => {
    const { dir, app, servers, userId } = await stranded();
    try {
      const code = codeOf(firstAdminCli([], { FORGE_DATA: dir }, NOW).out);
      credentials["a passkey"]!(app, userId);
      expect((await recover(servers.url, { code, scope: "rw" })).status).toBe(403);
    } finally {
      servers.stop();
      app.close();
    }
  });
});

describe("which admin is recovered", () => {
  test("with several stranded admins the operator names one with --user; nobody else", async () => {
    const { dir, app, servers } = await stranded("opsbot");
    try {
      const b = await createUser(app.db, { origin: "seed", trusted: true, username: "builder", email: "b@x.test", isAdmin: true });
      const plain = await createUser(app.db, { origin: "seed", trusted: true, username: "plain", email: "p@x.test" });
      if (!b.ok || !plain.ok) throw new Error("users");
      const ambiguous = firstAdminCli([], { FORGE_DATA: dir }, NOW);
      expect(ambiguous.exit).toBe(1);
      expect(ambiguous.err.join("\n")).toContain("--user");
      expect(firstAdminCli(["--user", "plain"], { FORGE_DATA: dir }).exit).toBe(1);
      expect(firstAdminCli(["--user", "nobody"], { FORGE_DATA: dir }).exit).toBe(1);
      const code = codeOf(firstAdminCli(["--user", "builder"], { FORGE_DATA: dir }).out);
      const res = await recover(servers.url, { code, scope: "rw" });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { user: { username: string } }).user.username).toBe("builder");
    } finally {
      servers.stop();
      app.close();
    }
  });

  test("a suspended admin is not recovered", async () => {
    const { dir, app, servers, userId } = await stranded();
    try {
      app.db.query("UPDATE user SET suspended_at = ?1 WHERE id = ?2").run(new Date().toISOString(), userId);
      expect(firstAdminCli([], { FORGE_DATA: dir }, NOW).exit).toBe(1);
    } finally {
      servers.stop();
      app.close();
    }
  });
});
