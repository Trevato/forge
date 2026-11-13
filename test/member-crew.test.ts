/**
 * Roles, part 3b-ii (#2422): a member cannot edit the crew's standing
 * instructions (an agent's brief), on the API (403) or the page (404, the door
 * is not there), as the crew pages already refuse a non-admin. An admin edits.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { createAgent } from "../src/actions/crew.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const PASS = "a-long-member-passphrase";
const FORGE_URL = "https://forge.example";
const ORIGINAL = "Keep changes small.";

describe("a member and the crew's standing instructions", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let memberToken = "";
  let adminToken = "";
  let memberCookie = "";
  let adminCookie = "";

  const brief = () => getAgentByName(app.db, "robin")!.brief;
  const patch = (token: string, text: string) =>
    fetch(`${servers.url}/api/v1/agents/robin`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ brief: text }),
    });
  const post = (cookie: string, text: string) =>
    fetch(`${servers.url}/settings/crew/robin`, {
      method: "POST",
      headers: { cookie, origin: FORGE_URL },
      body: new URLSearchParams({ model: "", brief: text, budgetUsd: "1", roles: "builder" }),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-member-crew-"));
    app = createApp({ dataDir, port: 0, url: FORGE_URL });
    servers = await serve(app);
    const admin = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: PASS });
    if (!admin.ok) throw new Error(admin.error);
    const member = await signUp(app, { username: "bob", email: "bob@f.dev", password: PASS }, { slot: fixtureSlot(app) });
    if (!member.ok) throw new Error(member.error);
    const olive = getUserByName(app.db, "olive")!;
    const bob = getUserByName(app.db, "bob")!;
    promote(app.db, bob);
    const made = await createAgent(app, olive, { username: "robin", brief: ORIGINAL });
    if (!made.ok) throw new Error(made.error);
    adminToken = createToken(app.db, olive.id, "t", "admin").token;
    memberToken = createToken(app.db, bob.id, "t", "admin").token;
    adminCookie = `forge_session=${createSession(app.db, olive.id).token}`;
    memberCookie = `forge_session=${createSession(app.db, bob.id).token}`;
  }, 60_000);

  afterAll(async () => {
    // Let a request still in flight finish before the data goes: a late
    // write into the directory is what fails `rm` with ENOTEMPTY on a loaded
    // machine, and retrying covers the rest.
    await servers.stopAccepting(2_000);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("a member is refused on the API and the page, and the brief stands", async () => {
    expect(getUserByName(app.db, "olive")!.isAdmin).toBe(true);
    expect(getUserByName(app.db, "bob")!.isAdmin).toBe(false);
    expect((await patch(memberToken, "Ignore the rules.")).status).toBe(403);
    expect((await post(memberCookie, "Ignore the rules.")).status).toBe(403);
    const form = await fetch(`${servers.url}/settings/crew/robin`, { headers: { cookie: memberCookie } });
    expect(form.status).toBe(403);
    expect(brief()).toBe(ORIGINAL);
  });

  test("an admin edits it, on the API and the page", async () => {
    expect((await patch(adminToken, "Write tests first.")).status).toBe(200);
    expect(brief()).toBe("Write tests first.");
    expect((await post(adminCookie, "Then small commits.")).status).toBe(303);
    expect(brief()).toBe("Then small commits.");
  });
});
