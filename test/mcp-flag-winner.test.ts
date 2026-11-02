/** MCP `flag_winner`: the page's make-the-winner-default, from a harness. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { makeFlags, useFlagRegistry } from "../src/core/flags.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-flag-passphrase";
const reg = makeFlags({ gamma: { why: "tries the new board", default: true, issue: 5440 } });

describe("MCP flag_winner", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const id = (name: string) => getUserByName(app.db, name)!.id;
  const winner = async (token: string, flagName: string, win: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flag_winner", arguments: { name: flagName, winner: win } } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-flagwin-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made.ok) throw new Error(username);
    }
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: id("alice"), name: "forge", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    useFlagRegistry(reg);
    for (let i = 0; i < 60; i++) reg.flag("gamma"); // on x60
    reg.set(app.db, "gamma", { users: ["u1"] }, "x");
  }, 30_000);

  afterAll(async () => {
    useFlagRegistry(undefined);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a non-admin is refused and nothing changes", async () => {
    const bob = createToken(app.db, id("bob"), "t", "admin").token;
    const r = await winner(bob, "gamma", "on");
    expect(r.error).toBe(true);
    expect(r.text).toContain("Flags are set by a forge admin.");
    expect(reg.value("gamma")).toEqual({ users: ["u1"] });
    expect(app.db.query("SELECT 1 FROM issue").all()).toEqual([]);
  });

  test("an admin's everyday rw or ro token is refused and nothing changes", async () => {
    for (const scope of ["rw", "ro"] as const) {
      const token = createToken(app.db, id("alice"), "t", scope).token;
      const r = await winner(token, "gamma", "on");
      expect(r.error).toBe(true);
      expect(r.text).toContain("forbidden");
      expect(reg.value("gamma")).toEqual({ users: ["u1"] });
      expect(app.db.query("SELECT 1 FROM issue").all()).toEqual([]);
    }
  });

  test("a winner that is not on or off is invalid and nothing changes", async () => {
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    const r = await winner(admin, "gamma", "maybe");
    expect(r.error).toBe(true);
    expect(r.text).toContain("invalid");
    expect(reg.value("gamma")).toEqual({ users: ["u1"] });
    expect(app.db.query("SELECT 1 FROM issue").all()).toEqual([]);
  });

  test("a winner the read-out does not offer is refused and the flag is unchanged", async () => {
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    const r = await winner(admin, "gamma", "off");
    expect(r.error).toBe(true);
    expect(r.text).toContain("That variant is not the winner yet.");
    expect(reg.value("gamma")).toEqual({ users: ["u1"] });
    expect(app.db.query("SELECT 1 FROM issue").all()).toEqual([]);
  });

  test("the offered winner becomes the default and the issue exists", async () => {
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    const r = await winner(admin, "gamma", "on");
    expect(r.error).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.name).toBe("gamma");
    expect(out.winner).toBe("on");
    expect(typeof out.says).toBe("string");
    expect(reg.value("gamma")).toEqual({ forge: true });
    const row = app.db.query<{ title: string }, [number]>("SELECT title FROM issue WHERE number = ?1").get(out.issue);
    expect(row?.title).toContain("Remove flag gamma");
  });
});
