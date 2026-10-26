/**
 * The sentinel in the terminal (#1131): the palette's `Sentinel` command is
 * a site admin's, as the board's strip is; a guest and an ordinary member
 * are not offered it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { clearErrors, createLog } from "../src/kernel/log.ts";
import { hunt } from "../src/crew/sentinel.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";

let dataDir: string;
let app: App;
let admin: User;
let member: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

function sentinelCommand(user?: User) {
  const toasts: string[] = [];
  const ctx = { toast: (t: string) => toasts.push(t) } as unknown as Ctx;
  const found = forgeCommands(new Session(app, identity(user)))(ctx).find(
    (c) => c.id === "sentinel",
  );
  return { found, toasts };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-sentinel-"));
  app = createApp({ dataDir, port: 0 });
  const mk = async (username: string, adminIfFirst: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  admin = await mk("alice", true);
  member = await mk("bob", false);
});
afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("the sentinel command", () => {
  test("an admin has it, and it says what the board says", async () => {
    const { found, toasts } = sentinelCommand(admin);
    expect(found).toBeDefined();
    found!.run();
    expect(toasts).toEqual(["The sentinel has not hunted yet"]);
    const made = await createRepo(app, admin, { name: "none", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    process.env["FORGE_SENTINEL_REPO"] = "alice/none";
    try {
      // The hunt reads the process's error log, which every other suite in
      // this process writes to; a loaded machine fills it with the same
      // ERROR line three times and the hunt files a finding. Empty it for
      // the read, so the hunt sees only this test's database.
      for (let i = 0; i < 3; i++) createLog("noise").error(`other suite failed ${i}`);
      clearErrors();
      hunt(app, "alice/none", Date.parse("2026-10-13T12:00:00.000Z"));
      found!.run();
    } finally {
      delete process.env["FORGE_SENTINEL_REPO"];
    }
    expect(toasts[1]).toBe("The sentinel found nothing · last hunt 2026-10-13 12:00");
  });

  test("a hunt that could not file does not say it found nothing", () => {
    app.db.run("CREATE TRIGGER stray_t AFTER INSERT ON user BEGIN SELECT 1; END");
    try {
      const { found, toasts } = sentinelCommand(admin);
      const prev = process.env["FORGE_SENTINEL_REPO"];
      process.env["FORGE_SENTINEL_REPO"] = "alice/gone";
      try {
        expect(hunt(app, "alice/gone", Date.parse("2026-10-13T13:00:00.000Z")).filed).toBe(0);
        found!.run();
        expect(toasts[0]).toBe("The sentinel cannot file: alice/gone not found · last hunt 2026-10-13 13:00");
      } finally {
        if (prev === undefined) delete process.env["FORGE_SENTINEL_REPO"];
        else process.env["FORGE_SENTINEL_REPO"] = prev;
      }
    } finally {
      app.db.run("DROP TRIGGER stray_t");
    }
  });

  test("a member and a guest are not offered it", () => {
    expect(sentinelCommand(member).found).toBeUndefined();
    expect(sentinelCommand(undefined).found).toBeUndefined();
  });
});
