// The keeper's record is the admins' (#7557): at each door that reads it — /releases, the terminal
// palette and screen, MCP `release_keeper` — a guest gets none of it and an admin gets all of it.
import { describe, expect, test } from "bun:test";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { tick } from "../src/keeper/keeper.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import { readKeeper } from "../src/tui/screens/keeper.ts";
import { quietLogs } from "./helpers/globals.ts";
import { keeperForge } from "./helpers/keeper.ts";

quietLogs();

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

/** 0.7.284 failed its verify and was rolled back to 0.7.283; a failed hold stands. A guest account `bob` beside the admin `alice`. */
async function seeded() {
  const f = await keeperForge();
  await tick(f.ports);
  f.world.live = "0.7.284";
  f.world.healthz = (n) => (n >= 5 ? { status: 503, ms: 2 } : { status: 200, ms: 2 });
  await tick(f.ports);
  const bob = await createUser(f.app.db, { username: "bob", email: "b@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
  if (!bob.ok) throw new Error("user");
  return { ...f, guest: bob.value };
}

describe("a guest sees no keeper data; an admin sees all of it", () => {
  test("/releases", async () => {
    const f = await seeded();
    const servers = await serve(f.app);
    try {
      const get = (user?: User) =>
        fetch(`${servers.url}/releases`, {
          headers: user === undefined ? {} : { cookie: `forge_session=${createSession(f.app.db, user.id).token}` },
          redirect: "manual",
        });
      const signedOut = await get();
      expect(signedOut.status).toBe(303);
      expect(signedOut.headers.get("location")).toContain("/signin");
      expect(await signedOut.text()).not.toContain("0.7.284");
      const guest = await get(f.guest);
      expect([403, 404]).toContain(guest.status);
      const guestBody = await guest.text();
      expect(guestBody).not.toContain("Release keeper");
      expect(guestBody).not.toContain("0.7.284");
      const admin = await get(f.user);
      expect(admin.status).toBe(200);
      const body = await admin.text();
      expect(body).toContain("Release keeper");
      expect(body).toContain("0.7.284");
      expect(body).toContain("0.7.283");
      expect(body).toContain("rolled back");
      expect(body).toContain("0.7.284 failed its verify");
    } finally {
      servers.stop();
    }
  });

  test("the terminal palette and screen", async () => {
    const f = await seeded();
    const offered = (user?: User) => forgeCommands(new Session(f.app, identity(user)))({} as Ctx).some((c) => c.id === "keeper");
    for (const who of [undefined, f.guest]) {
      expect(offered(who)).toBe(false);
      expect(readKeeper(new Session(f.app, identity(who)))).toBeUndefined();
    }
    expect(offered(f.user)).toBe(true);
    const read = readKeeper(new Session(f.app, identity(f.user)))!;
    expect(read.blocked).toContain("0.7.284 failed its verify");
    expect(read.releases.map((r) => [r.version, r.stage, r.knownGood.version])).toEqual([["0.7.284", "rolled_back", "0.7.283"]]);
  });

  test("MCP release_keeper", async () => {
    const f = await seeded();
    const servers = await serve(f.app);
    try {
      const call = async (user: User) => {
        const res = await fetch(`${servers.url}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${createToken(f.app.db, user.id, "ro", "ro").token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "release_keeper", arguments: {} } }),
        });
        const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
        return { isError: body.result.isError === true, text: body.result.content[0]!.text };
      };
      const guest = await call(f.guest);
      expect(guest.isError).toBe(true);
      expect(guest.text).not.toContain("0.7.284");
      const admin = await call(f.user);
      expect(admin.isError).toBe(false);
      const value = JSON.parse(admin.text);
      expect(value.blocked).toContain("0.7.284 failed its verify");
      expect(value.releases.map((r: { version: string; knownGood: { version: string } }) => [r.version, r.knownGood.version])).toEqual([["0.7.284", "0.7.283"]]);
      expect(value.holds).toHaveLength(1);
      expect(value.holds[0].kind).toBe("failed");
    } finally {
      servers.stop();
    }
  });
});
