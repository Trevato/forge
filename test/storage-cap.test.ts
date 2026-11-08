/**
 * The storage cap's words and figures (`core/storage.ts`): no limit asks
 * nothing, a stale figure is measured again, and a refusal names the figure
 * in human sizes and only the account's own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { getUserById } from "../src/core/users.ts";
import {
  BYTES_PER_MB,
  accountBytes,
  formatBytes,
  storageLimitBytes,
  storageLimitMessage,
  storageSentence,
  storageStale,
} from "../src/core/storage.ts";
import { repoDir } from "../src/git/repos.ts";
import { setQuota } from "../src/settings/quotas.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

describe("storage cap", () => {
  let dataDir: string;
  let app: App;
  let adaId: string;
  let bobId: string;
  let carolId: string;

  /** Add `bytes` of loose data to the repository `owner/name`, as a push would. */
  const grow = (owner: string, name: string, file: string, bytes: number) =>
    writeFile(join(repoDir(app.reposRoot, owner, name), file), new Uint8Array(bytes));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-storage-cap-"));
    app = createApp({ dataDir, port: 0 });
    const ada = await seedAdmin(app, { username: "ada", email: "ada@f.dev", password: "owner-passphrase" });
    const bob = await signUp(app, { username: "bob", email: "bob@f.dev", password: "bob-passphrase" }, { slot: fixtureSlot(app) });
    const carol = await signUp(app, { username: "carol", email: "carol@f.dev", password: "carol-passphrase" }, { slot: fixtureSlot(app) });
    if (!ada.ok || !bob.ok || !carol.ok) throw new Error("signup");
    proveAll(app);
    promote(app.db);
    adaId = ada.value.id;
    bobId = bob.value.id;
    carolId = carol.value.id;
    for (const [id, name] of [[bobId, "bobs"], [carolId, "carols"]] as const) {
      const made = await createRepo(app, getUserById(app.db, id)!, { name, visibility: "private" });
      if (!made.ok) throw new Error(`repo ${made.error}`);
    }
  });

  afterAll(async () => {
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no limit is undefined, a limit is its bytes, and a change is read on the next call", () => {
    expect(storageLimitBytes(app)).toBeUndefined();
    setQuota(app.db, "storage", 2, adaId);
    expect(storageLimitBytes(app)).toBe(2 * BYTES_PER_MB);
    setQuota(app.db, "storage", 5, adaId);
    expect(storageLimitBytes(app)).toBe(5 * BYTES_PER_MB);
    setQuota(app.db, "storage", null, adaId);
    expect(storageLimitBytes(app)).toBeUndefined();
  });

  test("a figure marked stale is measured again; until then the cached one stands", async () => {
    const before = await accountBytes(app, bobId);
    await grow("bob", "bobs", "extra.bin", 40_000);
    expect(await accountBytes(app, bobId)).toBe(before);
    storageStale(app, bobId);
    expect(await accountBytes(app, bobId)).toBe(before + 40_000);
    expect(await accountBytes(app, bobId)).toBe(before + 40_000);
  });

  test("the message names the account's figure and the limit in human sizes, never another's", async () => {
    await grow("carol", "carols", "big.bin", 3_000_000);
    storageStale(app, carolId);
    const carol = await accountBytes(app, carolId);
    const bob = await accountBytes(app, bobId);
    setQuota(app.db, "storage", 2, adaId);

    const msg = storageLimitMessage(app, carolId);
    expect(msg).toBe(`this account is at the forge's storage limit: ${formatBytes(carol)} of 2 MB`);
    expect(msg).toContain(" MB of 2 MB");
    expect(msg).not.toContain(String(carol));
    expect(msg).not.toContain(String(2 * BYTES_PER_MB));
    expect(msg).not.toContain(formatBytes(bob));

    // Bob is under the limit: his message carries no figure, and not carol's.
    const bobs = storageLimitMessage(app, bobId);
    expect(bobs).toBe("this account is at the forge's storage limit");
    expect(bobs).not.toContain(formatBytes(carol));
    setQuota(app.db, "storage", null, adaId);
    expect(storageLimitMessage(app, carolId)).toBe("this account is at the forge's storage limit");
  });

  test("the sentence reads right at nothing, just under and just over the limit", async () => {
    setQuota(app.db, "storage", 1, adaId);
    // Never measured: nothing to say.
    expect(storageSentence(app, adaId)).toBeUndefined();
    expect(await accountBytes(app, adaId)).toBe(0);
    expect(storageSentence(app, adaId)).toBeUndefined();

    // Just under: 900 kB of 1 MB is no refusal.
    await grow("bob", "bobs", "extra.bin", 900_000);
    storageStale(app, bobId);
    const under = await accountBytes(app, bobId);
    expect(under).toBeGreaterThan(900_000);
    expect(under).toBeLessThan(BYTES_PER_MB);
    expect(storageSentence(app, bobId)).toBeUndefined();

    // Just over.
    await grow("bob", "bobs", "extra.bin", 1_100_000);
    storageStale(app, bobId);
    const over = await accountBytes(app, bobId);
    expect(storageSentence(app, bobId)).toBe(`${formatBytes(over)} of 1 MB`);

    // No limit: no sentence, whatever is stored.
    setQuota(app.db, "storage", null, adaId);
    expect(storageSentence(app, bobId)).toBeUndefined();
  });
});
