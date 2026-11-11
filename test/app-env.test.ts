/**
 * An app's environment, at the rows: what a name may be, that a value is
 * sealed the moment it is stored and opens only for the app it belongs
 * to, that setting a name again replaces it, and that the forge's own
 * variables win over the operator's however the row was written.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { appEnv } from "../src/apps/process.ts";
import {
  deleteAppEnv,
  listAppEnvNames,
  resolveAppEnv,
  setAppEnv,
  VALUE_MAX,
} from "../src/core/app_env.ts";
import {
  createApp as insertApp,
  deleteApp,
  type AppRecord,
} from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("an app's environment", () => {
  let dataDir = "";
  let app: App;
  let hello: AppRecord;
  let twin: AppRecord;

  const stored = (appId: string, name: string): string | undefined =>
    app.db
      .query<
        { value_enc: string },
        [string, string]
      >("SELECT value_enc FROM app_env WHERE app_id = ?1 AND name = ?2")
      .get(appId, name)?.value_enc;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-env-"));
    app = createApp({ dataDir, port: 0 });
    const alice = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!alice.ok) throw new Error(alice.error);
    for (const name of ["hello", "twin"]) {
      const repo = await createRepo(app, alice.value, {
        name,
        visibility: "private",
      });
      if (!repo.ok) throw new Error(repo.error);
      const made = insertApp(app.db, {
        repoId: repo.value.id,
        slug: name,
        access: "private",
      });
      if (!made.ok) throw new Error(made.error);
      if (name === "hello") hello = made.value;
      else twin = made.value;
    }
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a name is shell-shaped, and the forge's own are refused", () => {
    for (const name of ["", "lower", "1ABC", "A-B", "A B", "A".repeat(129)]) {
      expect(setAppEnv(app.db, dataDir, hello.id, name, "x")).toEqual({
        ok: false,
        error: "invalid_name",
      });
    }
    for (const name of [
      "PORT",
      "HOST",
      "NODE_ENV",
      "PATH",
      "HOME",
      "LANG",
      "TMPDIR",
      "USER",
      "LOGNAME",
      "FORGE_APP_DATA",
      "FORGE_ANYTHING_AT_ALL",
    ]) {
      expect(setAppEnv(app.db, dataDir, hello.id, name, "x")).toEqual({
        ok: false,
        error: "reserved_name",
      });
    }
    for (const value of ["", "a\0b", "x".repeat(VALUE_MAX + 1)]) {
      expect(setAppEnv(app.db, dataDir, hello.id, "OK_NAME", value)).toEqual({
        ok: false,
        error: "invalid_value",
      });
    }
    expect(listAppEnvNames(app.db, hello.id)).toEqual([]);
  });

  test("a value is sealed at rest, opens for its app, and is never listed", () => {
    const secret = "correct horse battery staple";
    const set = setAppEnv(app.db, dataDir, hello.id, "ADMIN_PASSWORD", secret);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.name).toBe("ADMIN_PASSWORD");
    expect(JSON.stringify(set.value)).not.toContain("horse");

    const sealed = stored(hello.id, "ADMIN_PASSWORD");
    expect(sealed).toStartWith("v2:");
    expect(sealed).not.toContain("horse");
    expect(Buffer.from(sealed!, "utf8").toString("base64")).not.toContain(
      Buffer.from(secret).toString("base64"),
    );

    const names = listAppEnvNames(app.db, hello.id);
    expect(names.map((v) => v.name)).toEqual(["ADMIN_PASSWORD"]);
    expect(JSON.stringify(names)).not.toContain("horse");

    expect(resolveAppEnv(app.db, dataDir, hello.id, "production")).toEqual({
      ADMIN_PASSWORD: secret,
    });
    // Another app's environment is another app's.
    expect(resolveAppEnv(app.db, dataDir, twin.id, "production")).toEqual({});
  });

  test("setting a name again replaces the value and moves updated_at", async () => {
    const before = listAppEnvNames(app.db, hello.id)[0]!.updatedAt;
    const was = stored(hello.id, "ADMIN_PASSWORD");
    await Bun.sleep(5);
    const set = setAppEnv(
      app.db,
      dataDir,
      hello.id,
      "ADMIN_PASSWORD",
      "a new one",
    );
    expect(set.ok).toBe(true);
    expect(resolveAppEnv(app.db, dataDir, hello.id, "production")).toEqual({
      ADMIN_PASSWORD: "a new one",
    });
    const names = listAppEnvNames(app.db, hello.id);
    expect(names).toHaveLength(1);
    expect(names[0]!.updatedAt > before).toBe(true);
    // A fresh nonce every time: the same plaintext never seals the same way.
    expect(stored(hello.id, "ADMIN_PASSWORD")).not.toBe(was);
  });

  test("a ciphertext moved to another app or name will not open, and the rest still do", () => {
    expect(
      setAppEnv(app.db, dataDir, hello.id, "STRIPE_SECRET_KEY", "sk_live_123")
        .ok,
    ).toBe(true);
    const lifted = stored(hello.id, "ADMIN_PASSWORD")!;
    // Someone with SQL and no key copies hello's password onto twin…
    app.db
      .query(
        "INSERT INTO app_env (app_id, name, value_enc) VALUES (?1, 'ADMIN_PASSWORD', ?2)",
      )
      .run(twin.id, lifted);
    expect(resolveAppEnv(app.db, dataDir, twin.id, "production")).toEqual({});
    // …and under another name on hello itself.
    app.db
      .query(
        "INSERT INTO app_env (app_id, name, value_enc) VALUES (?1, 'RENAMED', ?2)",
      )
      .run(hello.id, lifted);
    expect(resolveAppEnv(app.db, dataDir, hello.id, "production")).toEqual({
      ADMIN_PASSWORD: "a new one",
      STRIPE_SECRET_KEY: "sk_live_123",
    });
    expect(deleteAppEnv(app.db, hello.id, "RENAMED")).toBe(true);
    expect(deleteAppEnv(app.db, twin.id, "ADMIN_PASSWORD")).toBe(true);
  });

  test("delete is exact, and says whether there was anything to delete", () => {
    expect(deleteAppEnv(app.db, hello.id, "STRIPE_SECRET_KEY")).toBe(true);
    expect(deleteAppEnv(app.db, hello.id, "STRIPE_SECRET_KEY")).toBe(false);
    expect(deleteAppEnv(app.db, twin.id, "ADMIN_PASSWORD")).toBe(false);
    expect(listAppEnvNames(app.db, hello.id).map((v) => v.name)).toEqual([
      "ADMIN_PASSWORD",
    ]);
  });

  test("the forge's own names win over the operator's, whatever the row says", () => {
    const env = appEnv({
      port: 4321,
      dataDir: "/data/hello/production/data",
      env: "production",
      url: "http://hello.apps.test",
      commitOid: "abc1234",
      forgeUrl: "http://forge.test",
      identityKey: "test-identity-key",
      vars: {
        PORT: "1",
        HOST: "0.0.0.0",
        FORGE_APP_DATA: "/elsewhere",
        FORGE_APP_PULL: "7",
        FORGE_APP_SSH: "ssh evil@host",
        PATH: "/evil",
        HOME: "/evil",
        GREETING: "hi",
      },
    });
    expect(env["PORT"]).toBe("4321");
    expect(env["HOST"]).toBe("127.0.0.1");
    expect(env["FORGE_APP_DATA"]).toBe("/data/hello/production/data");
    expect(env["FORGE_APP_PULL"]).toBeUndefined();
    expect(env["FORGE_APP_SSH"]).toBeUndefined();
    expect(env["PATH"]).not.toBe("/evil");
    expect(env["HOME"]).not.toBe("/evil");
    expect(env["GREETING"]).toBe("hi");
  });

  test("a scope decides who sees a value, and the narrower one wins", () => {
    expect(
      setAppEnv(app.db, dataDir, twin.id, "API_KEY", "everywhere").ok,
    ).toBe(true);
    expect(
      setAppEnv(app.db, dataDir, twin.id, "API_KEY", "sk_live", "production")
        .ok,
    ).toBe(true);
    expect(
      setAppEnv(app.db, dataDir, twin.id, "API_KEY", "sk_test", "preview").ok,
    ).toBe(true);
    expect(
      setAppEnv(app.db, dataDir, twin.id, "DEBUG", "1", "preview").ok,
    ).toBe(true);
    expect(setAppEnv(app.db, dataDir, twin.id, "REGION", "eu", "all").ok).toBe(
      true,
    );

    expect(resolveAppEnv(app.db, dataDir, twin.id, "production")).toEqual({
      API_KEY: "sk_live",
      REGION: "eu",
    });
    // Every preview is one scope, whichever pull it serves.
    for (const env of ["pull-3", "pull-41"])
      expect(resolveAppEnv(app.db, dataDir, twin.id, env)).toEqual({
        API_KEY: "sk_test",
        DEBUG: "1",
        REGION: "eu",
      });

    // The list names each row with its scope, widest first, and no value.
    expect(
      listAppEnvNames(app.db, twin.id).map((v) => `${v.name}@${v.scope}`),
    ).toEqual([
      "API_KEY@all",
      "API_KEY@production",
      "API_KEY@preview",
      "DEBUG@preview",
      "REGION@all",
    ]);
  });

  test("a delete takes one scope and leaves the others", () => {
    expect(deleteAppEnv(app.db, twin.id, "API_KEY", "production")).toBe(true);
    // Production falls back to what is set everywhere; previews keep theirs.
    expect(
      resolveAppEnv(app.db, dataDir, twin.id, "production")["API_KEY"],
    ).toBe("everywhere");
    expect(resolveAppEnv(app.db, dataDir, twin.id, "pull-3")["API_KEY"]).toBe(
      "sk_test",
    );
    // No scope named means `all`, as it did before there were scopes.
    expect(deleteAppEnv(app.db, twin.id, "DEBUG")).toBe(false);
    expect(deleteAppEnv(app.db, twin.id, "DEBUG", "preview")).toBe(true);
  });

  test("a scope is one of three words", () => {
    const bad = setAppEnv(app.db, dataDir, twin.id, "X_KEY", "v", "staging");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("invalid_scope");
  });

  test("rows from before there were scopes mean everywhere", () => {
    // What migration 24 does to an old table, on a scratch database.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const old = new Database(":memory:");
    old.exec(`
      CREATE TABLE app (id TEXT PRIMARY KEY);
      CREATE TABLE app_env (
        app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
        name TEXT NOT NULL, value_enc TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT 'then', updated_at TEXT NOT NULL DEFAULT 'then',
        PRIMARY KEY (app_id, name));
      INSERT INTO app VALUES ('a1');
      INSERT INTO app_env (app_id, name, value_enc) VALUES ('a1', 'ADMIN_PASSWORD', 'sealed');
    `);
    const { migrations } = require("../src/core/schema.ts") as {
      migrations: readonly string[];
    };
    // The scope rebuild is the one that mentions the scoped table, wherever
    // later migrations put it in the list.
    const rebuild = migrations.find((m) => m.includes("app_env_scoped"));
    if (rebuild === undefined) throw new Error("no scope migration");
    old.exec(rebuild);
    expect(
      old.query("SELECT name, scope, value_enc, updated_at FROM app_env").all(),
    ).toEqual([
      {
        name: "ADMIN_PASSWORD",
        scope: "all",
        value_enc: "sealed",
        updated_at: "then",
      },
    ]);
    old.close();
  });

  test("deleting the app takes its environment with it", () => {
    expect(deleteApp(app.db, hello.id)).toBe(true);
    expect(listAppEnvNames(app.db, hello.id)).toEqual([]);
    expect(stored(hello.id, "ADMIN_PASSWORD")).toBeUndefined();
  });
});
