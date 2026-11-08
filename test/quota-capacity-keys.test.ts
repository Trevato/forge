/**
 * An unknown quota or capacity key is refused by name, and a refusal changes
 * nothing: a batch with one unknown key applies none of it, and a caller who
 * is not a forge admin is turned away before any key is looked at.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeCapacity, listCapacity } from "../src/actions/capacity.ts";
import { changeQuotas } from "../src/actions/quotas.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getQuotas } from "../src/settings/quotas.ts";

describe("quota and capacity keys", () => {
  let dataDir: string;
  let app: App;
  let admin: User;
  let member: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-keys-"));
    app = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") admin = made.value;
      else member = made.value;
    }
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an unknown quota key refuses the whole batch, the known key too", () => {
    const before = getQuotas(app.db);
    const res = changeQuotas(app, admin, { repositories: 7, nonsense: 3 });
    expect(res).toEqual({ ok: false, error: "no_such_quota" });
    expect(getQuotas(app.db)).toEqual(before);
    // Order does not matter: the unknown key first is the same answer.
    expect(changeQuotas(app, admin, { nonsense: 3, apps: 2 })).toEqual({ ok: false, error: "no_such_quota" });
    expect(getQuotas(app.db)).toEqual(before);
  });

  test("an unknown capacity key is no_such_setting and the read is unchanged", () => {
    const before = listCapacity(app, admin);
    expect(changeCapacity(app, admin, "no.such.key", "3")).toEqual({ ok: false, error: "no_such_setting" });
    expect(listCapacity(app, admin)).toEqual(before);
  });

  test("a non-admin is refused before any key is looked at", () => {
    const before = getQuotas(app.db);
    expect(changeQuotas(app, member, { nonsense: 1 })).toEqual({ ok: false, error: "not_found" });
    expect(changeQuotas(app, undefined, { repositories: 1 })).toEqual({ ok: false, error: "not_found" });
    expect(changeCapacity(app, member, "no.such.key", "3")).toEqual({ ok: false, error: "not_found" });
    expect(changeCapacity(app, undefined, "no.such.key", null)).toEqual({ ok: false, error: "not_found" });
    expect(getQuotas(app.db)).toEqual(before);
  });
});
