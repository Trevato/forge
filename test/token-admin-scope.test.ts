/**
 * #2425: a member cannot mint an admin-scope token (403, one plain sentence);
 * ro and rw are unchanged, and an admin still mints admin.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { ADMIN_TOKEN_WORDS } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";

quietLogs();

const PASS = "a-long-member-passphrase";

describe("minting an admin-scope token", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const mint = (username: string, scope: string) =>
    fetch(`${servers.url}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASS, name: "t", scope, adminConfirm: true }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-token-admin-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: PASS });
    const made = await signUp(app, { username: "bob", email: "bob@f.dev", password: PASS }, { slot: fixtureSlot(app) });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a member gets 403 for admin and 201 for rw and ro", async () => {
    const denied = await mint("bob", "admin");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { message: string }).message).toBe(ADMIN_TOKEN_WORDS);
    expect((await mint("bob", "rw")).status).toBe(201);
    expect((await mint("bob", "ro")).status).toBe(201);
  });

  test("an admin can still mint admin", async () => {
    expect((await mint("olive", "admin")).status).toBe(201);
  });
});
