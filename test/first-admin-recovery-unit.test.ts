/**
 * The recovery half of `core/first_admin.ts` called directly, with `now` passed
 * in: a code is spent once, never when expired, `unburnFirstAdmin` gives back
 * only a spent code, and `strandedAdmins` / `adminCanSignIn` follow credentials.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import {
  FIRST_ADMIN_TTL_MS,
  adminCanSignIn,
  burnFirstAdminRecovery,
  mintFirstAdminRecovery,
  strandedAdmins,
  unburnFirstAdmin,
} from "../src/core/first_admin.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const NOW = Date.now();

/** One admin with no credential at all. */
async function stranded() {
  const dir = await mkdtemp(join(tmpdir(), "forge-first-admin-unit-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0, passkeyOnlySignup: true });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "opsbot", email: "opsbot@x.test", isAdmin: true });
  if (!made.ok) throw new Error("user");
  return { db: app.db, id: made.value.id };
}

test("a minted code burns once and returns the admin's id", async () => {
  const { db, id } = await stranded();
  const { code } = mintFirstAdminRecovery(db, id, NOW)!;
  expect(burnFirstAdminRecovery(db, code, NOW + 1000)).toBe(id);
  expect(burnFirstAdminRecovery(db, code, NOW + 2000)).toBeUndefined();
});

test("an expired, unknown or empty code is worth nothing", async () => {
  const { db, id } = await stranded();
  const { code } = mintFirstAdminRecovery(db, id, NOW)!;
  expect(burnFirstAdminRecovery(db, code, NOW + FIRST_ADMIN_TTL_MS)).toBeUndefined();
  expect(burnFirstAdminRecovery(db, "A".repeat(43), NOW)).toBeUndefined();
  expect(burnFirstAdminRecovery(db, "", NOW)).toBeUndefined();
  // Still unspent: just inside the deadline it works.
  expect(burnFirstAdminRecovery(db, code, NOW + FIRST_ADMIN_TTL_MS - 1)).toBe(id);
});

test("unburnFirstAdmin makes a spent code usable once more, and ignores the rest", async () => {
  const { db, id } = await stranded();
  const { code } = mintFirstAdminRecovery(db, id, NOW)!;
  expect(burnFirstAdminRecovery(db, code, NOW)).toBe(id);
  unburnFirstAdmin(db, code);
  expect(burnFirstAdminRecovery(db, code, NOW)).toBe(id);
  expect(burnFirstAdminRecovery(db, code, NOW)).toBeUndefined();
  // An unknown code gives nothing back; the spent one stays spent.
  unburnFirstAdmin(db, "B".repeat(43));
  unburnFirstAdmin(db, "");
  expect(burnFirstAdminRecovery(db, code, NOW)).toBeUndefined();
});

test("a code that was never spent is untouched by unburn", async () => {
  const { db, id } = await stranded();
  const { code } = mintFirstAdminRecovery(db, id, NOW)!;
  unburnFirstAdmin(db, code);
  expect(burnFirstAdminRecovery(db, code, NOW)).toBe(id);
  expect(burnFirstAdminRecovery(db, code, NOW)).toBeUndefined();
});

test("strandedAdmins lists an admin with no way in, and adminCanSignIn turns true with one", async () => {
  const { db, id } = await stranded();
  expect(strandedAdmins(db).map((a) => a.id)).toEqual([id]);
  expect(adminCanSignIn(db, NOW)).toBe(false);
  createToken(db, id, "t", "admin", { expiresAt: new Date(NOW - 1000).toISOString() });
  expect(adminCanSignIn(db, NOW)).toBe(false);
  createToken(db, id, "t2", "admin", { expiresAt: new Date(NOW + 60_000).toISOString() });
  expect(adminCanSignIn(db, NOW)).toBe(true);
  // Once someone can sign in, no recovery code is minted.
  expect(mintFirstAdminRecovery(db, id, NOW)).toBeUndefined();
});
