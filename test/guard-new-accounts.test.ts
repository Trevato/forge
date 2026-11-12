/**
 * The new-account repository guard (`guard_new_accounts`): a forge setting,
 * default off, that refuses repository creation and forks for accounts
 * younger than a week. It replaces the hand-installed database trigger that
 * used to do this with no toggle — the setting refuses in the trigger's own
 * words, and booting drops the legacy trigger.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import {
  NEW_ACCOUNT_GUARD_MESSAGE,
  capacityValue,
} from "../src/core/capacity.ts";
import { dropLegacyNewAccountGuards } from "../src/core/schema.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { NEW_FOR_MS } from "../src/actions/accounts.ts";
import { promote } from "./helpers/members.ts";

describe("guard_new_accounts", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: User;
  let newcomer: User;
  let oldtimer: User;
  let agent: User;

  const oldDate = new Date(
    Date.now() - NEW_FOR_MS - 24 * 3_600_000,
  ).toISOString();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-guard-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);

    const mk = async (
      username: string,
      opts: { adminIfFirst?: true; backdate?: boolean } = {},
    ): Promise<User> => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        ...(opts.adminIfFirst === true ? { adminIfFirst: true as const } : {}),
      });
      if (!made.ok) throw new Error(made.error);
      promote(app.db, made.value);
      if (opts.backdate)
        app.db
          .query("UPDATE user SET created_at = ?1 WHERE id = ?2")
          .run(oldDate, made.value.id);
      return {
        ...made.value,
        createdAt: opts.backdate ? oldDate : made.value.createdAt,
      };
    };

    admin = await mk("ada", { adminIfFirst: true });
    newcomer = await mk("newcomer");
    oldtimer = await mk("oldtimer", { backdate: true });
    const madeAgent = await createAgent(app, admin, { username: "scout" });
    if (!madeAgent.ok) throw new Error(String(madeAgent.error));
    agent = madeAgent.value.user;
  });

  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("default is off: a new account creates and forks", async () => {
    expect(capacityValue(app.db, "guard_new_accounts")).toBe("off");
    const created = await createRepo(app, newcomer, { name: "fresh" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const forked = await forkRepo(app, newcomer, created.value, "fresh-fork");
    expect(forked.ok).toBe(true);
  });

  test("on: a new account is refused, in the legacy trigger's words", async () => {
    const changed = changeCapacity(app, admin, "guard_new_accounts", "on");
    expect(changed.ok).toBe(true);

    const created = await createRepo(app, newcomer, { name: "blocked" });
    expect(created).toEqual({ ok: false, error: "refused" });

    const parent = await createRepo(app, oldtimer, {
      name: "parent",
      visibility: "public",
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const forked = await forkRepo(app, newcomer, parent.value);
    expect(forked).toEqual({ ok: false, error: "refused" });

    // Back to off for the other tests.
    expect(changeCapacity(app, admin, "guard_new_accounts", "off").ok).toBe(
      true,
    );
  });

  test("on: an account older than a week may create and fork", async () => {
    expect(changeCapacity(app, admin, "guard_new_accounts", "on").ok).toBe(
      true,
    );
    const created = await createRepo(app, oldtimer, { name: "seasoned" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const forked = await forkRepo(
      app,
      oldtimer,
      created.value,
      "seasoned-fork",
    );
    expect(forked.ok).toBe(true);
    expect(changeCapacity(app, admin, "guard_new_accounts", "off").ok).toBe(
      true,
    );
  });

  test("on: admins and agents are not held back", async () => {
    expect(changeCapacity(app, admin, "guard_new_accounts", "on").ok).toBe(
      true,
    );
    // The admin here is new (just made) — the guard still lets them through.
    const created = await createRepo(app, admin, {
      name: "admin-made",
      visibility: "public",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const forked = await forkRepo(app, agent, created.value);
    expect(forked.ok).toBe(true);
    expect(changeCapacity(app, admin, "guard_new_accounts", "off").ok).toBe(
      true,
    );
  });

  test("only on/off are valid values", () => {
    expect(changeCapacity(app, admin, "guard_new_accounts", "maybe").ok).toBe(
      false,
    );
    expect(changeCapacity(app, admin, "guard_new_accounts", "maybe")).toEqual({
      ok: false,
      error: "invalid_value",
    });
  });

  test("api: a refused creation is 403 with the guard's words", async () => {
    expect(changeCapacity(app, admin, "guard_new_accounts", "on").ok).toBe(
      true,
    );
    const token = createToken(app.db, newcomer.id, "t", "rw").token;
    const res = await fetch(`${servers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "api-blocked" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "refused",
      message: NEW_ACCOUNT_GUARD_MESSAGE,
    });
    expect(changeCapacity(app, admin, "guard_new_accounts", "off").ok).toBe(
      true,
    );
  });

  test("api: the setting is flippable by an admin", async () => {
    const token = createToken(app.db, admin.id, "t", "admin").token;
    const get = () =>
      fetch(`${servers.url}/api/v1/admin/capacity`, {
        headers: { authorization: `Bearer ${token}` },
      }).then(
        (r) =>
          r.json() as Promise<{
            items: { key: string; value: string }[];
            next_cursor: null;
          }>,
      );
    const keys = (await get()).items.map((s) => s.key);
    expect(keys).toContain("guard_new_accounts");

    const put = (value: string) =>
      fetch(`${servers.url}/api/v1/admin/capacity/guard_new_accounts`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value }),
      });
    expect((await put("on")).status).toBe(200);
    expect(capacityValue(app.db, "guard_new_accounts")).toBe("on");
    expect((await put("off")).status).toBe(200);
    expect(capacityValue(app.db, "guard_new_accounts")).toBe("off");
  });
});

describe("dropLegacyNewAccountGuards", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-guard-mig-"));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("drops only triggers carrying the guard's message", () => {
    app = createApp({ dataDir, port: 0 });
    // A hand-installed legacy guard, in the operator's own words and name.
    app.db.exec(`CREATE TRIGGER guard_noobs BEFORE INSERT ON repo
      BEGIN
        SELECT RAISE(ABORT, 'new accounts cannot create repositories yet');
      END;`);
    // Something else entirely, on the same table: hands off.
    app.db.exec(`CREATE TRIGGER repo_touch AFTER INSERT ON repo
      BEGIN
        UPDATE repo SET description = description WHERE id = NEW.id;
      END;`);
    // A trigger on another table that happens to mention the words.
    app.db.exec(`CREATE TRIGGER user_touch AFTER INSERT ON "user"
      BEGIN
        SELECT RAISE(ABORT, 'nothing about new accounts cannot create repositories here');
      END;`);
    // The second generation of the guard, as the live forge carried it: it
    // waited for spending limits that have long since arrived, and refused
    // the forge's own admin — on another table, in other words.
    app.db.exec(`CREATE TRIGGER guard_paused BEFORE INSERT ON app
      BEGIN
        SELECT RAISE(ABORT, 'This is paused for new accounts while the forge adds spending and resource limits. Ask the forge''s owner.');
      END;`);
    // The operator's family of 2026-10-05: named steward_…, on run and on
    // repo_crew, refusing anyone outside a hand-kept table.
    app.db.exec(
      `CREATE TABLE IF NOT EXISTS steward_trusted_owner(user_id TEXT PRIMARY KEY, note TEXT);`,
    );
    app.db.exec(`CREATE TRIGGER steward_guard_crew BEFORE INSERT ON repo_crew
      WHEN (SELECT owner_id FROM repo WHERE id = NEW.repo_id) NOT IN (SELECT user_id FROM steward_trusted_owner)
      BEGIN SELECT RAISE(ABORT, 'crew is not enabled for this account yet'); END;`);
    app.db.exec(`CREATE TRIGGER steward_hold_build_checks BEFORE INSERT ON run
      BEGIN SELECT RAISE(ABORT, 'held by the steward'); END;`);

    const dropped = dropLegacyNewAccountGuards(app.db);
    expect(dropped.sort()).toEqual([
      "guard_noobs",
      "guard_paused",
      "steward_guard_crew",
      "steward_hold_build_checks",
    ]);

    const remaining = app.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(remaining).toContain("repo_touch");
    expect(remaining).toContain("user_touch");
    expect(remaining).not.toContain("guard_noobs");

    // A second boot changes nothing.
    expect(dropLegacyNewAccountGuards(app.db)).toEqual([]);
  });

  test("boot drops a planted legacy trigger", async () => {
    // A fresh data dir: createApp is the boot, and the trigger is planted
    // before it by hand — the way an operator would have.
    const dir2 = await mkdtemp(join(tmpdir(), "forge-guard-boot-"));
    const first = createApp({ dataDir: dir2, port: 0 });
    first.db.exec(`CREATE TRIGGER legacy_guard BEFORE INSERT ON repo
      BEGIN
        SELECT RAISE(ABORT, 'new accounts cannot create repositories yet, sorry');
      END;`);
    // Reboot: a new App on the same data dir runs the cleanup.
    const second = createApp({ dataDir: dir2, port: 0 });
    const triggers = second.db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'legacy_guard'")
      .all();
    expect(triggers).toEqual([]);
    await rm(dir2, { recursive: true, force: true });
  });
});
