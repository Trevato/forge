/** Signing in through another forge (#748): a login in flight is taken once and expires; a parent link is one per account and issuer. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  LOGIN_TTL_MS,
  linkParent,
  linkedAccount,
  parentIssuerOf,
  startLogin,
  takeLogin,
  unlinkParent,
} from "../src/core/federation.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ISSUER = "https://parent.test";
const login = { verifier: "v-1", nonce: "n-1", issuer: ISSUER, redirectUri: `${ISSUER}/cb` };

describe("federation", () => {
  let dataDir = "";
  let app: App;
  const id = (name: string) => getUserByName(app.db, name)!.id;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-federation-"));
    app = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@x.test`,
        password: "a-long-federation-passphrase",
      });
      if (!made.ok) throw new Error(username);
    }
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a started login is taken once with its stored fields", () => {
    startLogin(app.db, "state-a", { ...login, linkUser: "u1" }, 1000);
    expect(takeLogin(app.db, "state-a", 2000)).toEqual({ ...login, linkUser: "u1" });
    expect(takeLogin(app.db, "state-a", 2000)).toBeUndefined();
  });

  test("a sign-in carries no linkUser", () => {
    startLogin(app.db, "state-b", login, 1000);
    expect(takeLogin(app.db, "state-b", 1001)).toEqual(login);
  });

  test("a login taken after its lifetime is undefined, and an unknown state too", () => {
    startLogin(app.db, "state-c", login, 1000);
    expect(takeLogin(app.db, "state-c", 1000 + LOGIN_TTL_MS)).toBeUndefined();
    startLogin(app.db, "state-d", login, 1000);
    expect(takeLogin(app.db, "state-d", 1000 + LOGIN_TTL_MS - 1)).toEqual(login);
    expect(takeLogin(app.db, "never-started", 1000)).toBeUndefined();
  });

  test("only the hash of the state is stored", () => {
    startLogin(app.db, "raw-state-secret", login, 5000);
    const rows = app.db.query("SELECT * FROM rp_login").all() as { state_hash: string }[];
    expect(rows.map((r) => r.state_hash)).toContain(sha256("raw-state-secret"));
    expect(JSON.stringify(rows)).not.toContain("raw-state-secret");
    takeLogin(app.db, "raw-state-secret", 5000);
  });

  test("a linked parent identity finds its account and unlinking removes it", () => {
    expect(linkedAccount(app.db, ISSUER, "sub-1")).toBeUndefined();
    expect(linkParent(app.db, id("alice"), ISSUER, "sub-1")).toEqual({ ok: true, value: "linked" });
    expect(linkedAccount(app.db, ISSUER, "sub-1")?.username).toBe("alice");
    expect(linkedAccount(app.db, "https://other.test", "sub-1")).toBeUndefined();
    expect(unlinkParent(app.db, id("alice"), ISSUER)).toEqual({ ok: true, value: "unlinked" });
    expect(linkedAccount(app.db, ISSUER, "sub-1")).toBeUndefined();
    expect(unlinkParent(app.db, id("alice"), ISSUER)).toEqual({ ok: true, value: "none" });
  });

  test("an issuer and sub belong to one account; an account holds one sub per issuer", () => {
    linkParent(app.db, id("alice"), ISSUER, "sub-2");
    expect(linkParent(app.db, id("alice"), ISSUER, "sub-2")).toEqual({ ok: true, value: "linked" });
    expect(linkParent(app.db, id("bob"), ISSUER, "sub-2")).toEqual({ ok: false, error: "identity_taken" });
    expect(linkParent(app.db, id("alice"), ISSUER, "sub-3")).toEqual({ ok: false, error: "already_linked" });
    expect(linkedAccount(app.db, ISSUER, "sub-2")?.username).toBe("alice");
    expect(linkedAccount(app.db, ISSUER, "sub-3")).toBeUndefined();
    unlinkParent(app.db, id("alice"), ISSUER);
  });

  test("parentIssuerOf reads the configured parent and is undefined without one", async () => {
    expect(parentIssuerOf({ dataDir, parentUrl: "https://parent.test/x" })).toBe(ISSUER);
    expect(parentIssuerOf({ dataDir, parentUrl: "http://parent.test" })).toBeUndefined();
    expect(parentIssuerOf({ dataDir })).toBeUndefined();
    const recorded = await mkdtemp(join(tmpdir(), "forge-federation-rec-"));
    try {
      await writeFile(join(recorded, "parent.json"), JSON.stringify({ upstream: "https://spawn.test" }));
      expect(parentIssuerOf({ dataDir: recorded })).toBe("https://spawn.test");
    } finally {
      await rm(recorded, { recursive: true, force: true });
    }
  });
});
