/**
 * A child's founder account holds the spawner's own username (`copyInto`).
 * Two things follow, both from one forge, `grokbot`, spawning `grokbot`:
 * - a child named after its spawner can't get its organisation (the founder
 *   holds the name): the dry run and the spawn refuse it plainly, before a
 *   body is placed, instead of a 500 `name_taken` half-way through;
 * - the spawner could never claim their child as themselves: the claim now
 *   takes over that untouched founder account, but only when the spawner is
 *   leaving (keepAccess false) and the account has no credential of its own
 *   (no password, passkey, token, SSH key, session, parent sign-in, edge
 *   link or OAuth-client grant). That is deliberate: whoever
 *   holds the link becomes the spawner's name on the child, and the claim
 *   page says so before anyone submits.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf, founderClash } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { linkEdgeLogin } from "../src/core/edge_links.ts";
import { linkParent } from "../src/core/federation.ts";
import { addKey, parseAuthorizedKey } from "../src/core/keys.ts";
import { listPasskeys } from "../src/core/passkeys.ts";
import { createSession, sessionUser } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const PASSWORD = "a-long-claim-passphrase";

describe("a child's founder holds the spawner's name", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let adminRw = "";
  const kids: { app: App; servers: Servers }[] = [];

  const spawn = (body: Record<string, unknown>) =>
    fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminRw}`, "content-type": "application/json" },
      body: JSON.stringify({ apps: [], ...body }),
    });

  /** A real child, booted and served on its own, with its claim token. */
  const child = async (name: string, keepAccess: boolean, edgeToken?: string) => {
    const made = await spawn({ name, keepAccess, dryRun: false });
    if (made.status !== 201) throw new Error(`spawn ${made.status} ${await made.text()}`);
    const body = (await made.json()) as { claimUrl: string; bodyId: string };
    const app = createApp({
      dataDir: childDirOf(parent, body.bodyId),
      port: 0,
      ...(edgeToken === undefined ? {} : { edgeToken }),
    });
    await firstBoot(app);
    const servers = await serve(app);
    kids.push({ app, servers });
    const claim = (form: Record<string, string>) =>
      fetch(`${servers.url}/claim`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({ token: body.claimUrl.split("#")[1] ?? "", ...form }),
        redirect: "manual",
      });
    return { app, servers, claim, token: body.claimUrl.split("#")[1] ?? "" };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-founder-name-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    if (!alice.ok) throw new Error("user");
    adminRw = createToken(parent.db, alice.value.id, "rw", "rw").token;
    parentServers = await serve(parent);
  });

  afterAll(async () => {
    for (const k of kids) {
      k.servers.stop();
      k.app.close();
    }
    parentServers?.stop();
    parent?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the dry run refuses a child named after its spawner, as the spawn would", async () => {
    const dry = await spawn({ name: "alice", dryRun: true });
    expect(dry.status).toBe(422);
    const said = (await dry.json()) as { error: string; message: string };
    expect(said.error).toBe("invalid");
    expect(said.message).toContain("name: alice is the name of the child's founder account");
  });

  test("the spawn refuses it before anything is placed: no 500, no ledger, no body", async () => {
    const real = await spawn({ name: "Alice".toLowerCase(), dryRun: false });
    expect(real.status).toBe(422);
    expect(existsSync(join(dir, "spawn", "alice.json"))).toBe(false);
    expect(existsSync(join(dir, "children"))).toBe(false);
  });

  test("a stranger's child can't take the placeholder founder's name either", () => {
    expect(founderClash({ name: "founder", org: "founder" }, undefined)?.field).toBe("name");
    expect(founderClash({ name: "kid", org: "founder" }, undefined)?.field).toBe("org");
    expect(founderClash({ name: "kid", org: "kid" }, undefined)).toBeUndefined();
  });

  test("the spawner claims their child as themselves: the untouched founder becomes theirs", async () => {
    const kid = await child("maria", false);
    const founder = getUserByName(kid.app.db, "alice");
    expect(founder).toBeDefined();
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("forge_session=");
    const now = getUserByName(kid.app.db, "alice")!;
    // The same account, not a second one: what the spawn made under it stays its.
    expect(now.id).toBe(founder!.id);
    expect(now.isAdmin).toBe(true);
    expect(now.email).toBe("alice@x.test");
    // Its new password signs in.
    const signin = await fetch(`${kid.servers.url}/signin`, {
      method: "POST",
      headers: { origin: kid.servers.url },
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    expect(signin.status).toBe(303);
    // And the link is spent.
    const again = await kid.claim({ username: "someone", email: "s@x.test", password: PASSWORD });
    expect(again.status).not.toBe(303);
  });

  test("a passkey claim takes the founder over the same way", async () => {
    const kid = await child("zed", false);
    const founder = getUserByName(kid.app.db, "alice")!;
    const form = { token: kid.token, username: "alice", email: "alice@x.test" };
    const key = await passkeyFields(kid.servers.url, "/claim/options", form);
    const res = await kid.claim({ ...form, ...key });
    expect(res.status).toBe(303);
    const now = getUserByName(kid.app.db, "alice")!;
    expect(now.id).toBe(founder.id);
    expect(now.isAdmin).toBe(true);
    expect(listPasskeys(kid.app.db, now.id)).toHaveLength(1);
  });

  test("when the spawner keeps access, their founder account is not the claimant's to take", async () => {
    const kid = await child("kai", true);
    const founder = getUserByName(kid.app.db, "alice")!;
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
    expect(getUserByName(kid.app.db, "alice")!.isAdmin).toBe(founder.isAdmin);
    // The link is not spent by the refusal.
    const other = await kid.claim({ username: "kai-owner", email: "k@x.test", password: PASSWORD });
    expect(other.status).toBe(303);
  });

  test("a founder that already holds a credential is never taken over", async () => {
    const kid = await child("lee", false);
    const founder = getUserByName(kid.app.db, "alice")!;
    createToken(kid.app.db, founder.id, "held", "rw");
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
    expect(getUserByName(kid.app.db, "alice")!.email).toBe(founder.email);
  });

  test("a founder with an SSH key can already push, so it is never handed over", async () => {
    const kid = await child("sam", false);
    const founder = getUserByName(kid.app.db, "alice")!;
    const parsed = parseAuthorizedKey(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo alice",
    );
    if (!parsed.ok) throw new Error("key");
    expect(addKey(kid.app.db, founder.id, "laptop", parsed.value).ok).toBe(true);
    // The page makes no takeover promise for it.
    const page = await (await fetch(`${kid.servers.url}/claim`)).text();
    expect(page).not.toContain('id="claim-takeover"');
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
    const now = getUserByName(kid.app.db, "alice")!;
    expect(now.email).toBe(founder.email);
    expect(now.isAdmin).toBe(founder.isAdmin);
  });

  test("the claim page says, before anyone submits, that claiming as the spawner takes over their account", async () => {
    const kid = await child("nia", false);
    const page = await (await fetch(`${kid.servers.url}/claim`)).text();
    expect(page).toContain('id="claim-takeover"');
    expect(page).toContain("Open it as alice and you will take over alice's account on this forge");
    // Where it does not apply (the spawner keeps access), the page makes no such promise.
    const kept = await child("ona", true);
    expect(await (await fetch(`${kept.servers.url}/claim`)).text()).not.toContain('id="claim-takeover"');
  });

  test("where the platform edge signs people in, the founder's name is a login, never handed over", async () => {
    const kid = await child("eve", false, "edge-secret-for-this-test-only");
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
  });

  test("a founder with a session can already sign in, so it is never handed over", async () => {
    const kid = await child("ivy", false);
    const founder = getUserByName(kid.app.db, "alice")!;
    const sess = createSession(kid.app.db, founder.id);
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
    const now = getUserByName(kid.app.db, "alice")!;
    expect(now.email).toBe(founder.email);
    expect(now.isAdmin).toBe(founder.isAdmin);
    // The old cookie still belongs to the untouched founder, not a new admin.
    const who = sessionUser(kid.app.db, sess.token);
    expect(who.ok).toBe(true);
    if (who.ok) expect(who.value.id).toBe(founder.id);
  });

  test("a founder linked to a parent sign-in is never handed over", async () => {
    const kid = await child("joy", false);
    const founder = getUserByName(kid.app.db, "alice")!;
    expect(linkParent(kid.app.db, founder.id, "https://parent.test", "alice-sub").ok).toBe(true);
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
    expect(getUserByName(kid.app.db, "alice")!.email).toBe(founder.email);
    expect(getUserByName(kid.app.db, "alice")!.isAdmin).toBe(founder.isAdmin);
  });

  test("a founder with an edge login link is never handed over", async () => {
    const kid = await child("kim", false);
    const founder = getUserByName(kid.app.db, "alice")!;
    expect(linkEdgeLogin(kid.app.db, founder, "alice-edge").ok).toBe(true);
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
    expect(getUserByName(kid.app.db, "alice")!.email).toBe(founder.email);
    expect(getUserByName(kid.app.db, "alice")!.isAdmin).toBe(founder.isAdmin);
  });

  test("a founder with an OAuth-client grant is never handed over", async () => {
    const kid = await child("pat", false);
    const founder = getUserByName(kid.app.db, "alice")!;
    // A refresh token is a live grant even with no access token row.
    kid.app.db
      .query(
        `INSERT INTO oauth_refresh (token_hash, family, client_id, user_id, scope, name, lifetime_s, expires_at)
         VALUES (?1, ?2, ?3, ?4, 'rw', 'grant', 3600, '2099-01-01T00:00:00.000Z')`,
      )
      .run(`rh-${founder.id}`, `fam-${founder.id}`, "client-test", founder.id);
    const res = await kid.claim({ username: "alice", email: "alice@x.test", password: PASSWORD });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That username is taken.");
    expect(getUserByName(kid.app.db, "alice")!.email).toBe(founder.email);
    expect(getUserByName(kid.app.db, "alice")!.isAdmin).toBe(founder.isAdmin);
  });
});
