/** `readFlags`: the declared flags as plain data, for a forge admin only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFlags } from "../src/actions/flags_view.ts";
import { createApp, type App } from "../src/app.ts";
import { FLAGS_ADMIN_ONLY, makeFlags, useFlagRegistry } from "../src/core/flags.ts";
import { createUser, type User } from "../src/core/users.ts";

const reg = makeFlags({ alpha: { why: "shows the new board", default: false, issue: 12 } });

describe("readFlags", () => {
  let dataDir: string;
  let app: App;
  let admin: User;
  let bob: User;

  const mk = async (username: string, adminIfFirst: boolean) => {
    const u = await createUser(app.db, {
      origin: "seed",
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      trusted: true,
      adminIfFirst,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flags-view-"));
    app = createApp({ dataDir, port: 0 });
    admin = await mk("alice", true);
    bob = await mk("bob", false);
    useFlagRegistry(reg);
  });
  afterAll(async () => {
    useFlagRegistry(undefined);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sees each flag with its default, and the live value once set", () => {
    const before = readFlags(admin);
    expect(before).toEqual({
      ok: true,
      flags: [{ name: "alpha", why: "shows the new board", default: false, issue: 12, value: undefined }],
    });
    reg.set(app.db, "alpha", { forge: true }, admin.id);
    const after = readFlags(admin);
    expect(after.ok && after.flags[0]?.value).toEqual({ forge: true });
    expect(after.ok && after.flags[0]?.default).toBe(false);
  });

  test("a non-admin, an agent and nobody are refused", () => {
    const refusal = { ok: false as const, message: FLAGS_ADMIN_ONLY };
    expect(readFlags(bob)).toEqual(refusal);
    expect(readFlags({ ...admin, kind: "agent" })).toEqual(refusal);
    expect(readFlags(undefined)).toEqual(refusal);
  });
});
