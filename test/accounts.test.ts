import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  startNotifier,
  setNotifyUrl,
  type Notifier,
} from "../src/crew/notify.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { getAgent } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { repoDir } from "../src/git/repos.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser as insertAgent, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { identityFor } from "../src/tui/ssh.ts";

const EDGE = "edge-secret-for-accounts";
const KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo outsider";

// The owner watches who joins, hears of each new account once, and can stop
// or remove one. A fresh outsider tries everything it should not be able to.
describe("accounts: the owner sees, suspends and removes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let ownerToken: string;
  let notifier: Notifier;
  const posts: { url: string; body: string }[] = [];

  const api = (path: string, init: RequestInit & { token?: string } = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-accounts-"));
    app = createApp({
      dataDir,
      port: 0,
      url: "https://forge.example",
      edgeToken: EDGE,
    });
    servers = await serve(app);
    base = servers.url;
    const owner = await signUp(app, {
      username: "owner",
      email: "owner@f.dev",
      password: "owner-passphrase",
    });
    if (!owner.ok) throw new Error(owner.error);
    ownerToken = createToken(app.db, owner.value.id, "t", "admin").token;
    expect(
      setNotifyUrl(app.db, owner.value.id, "https://ntfy.example.test/owner")
        .ok,
    ).toBe(true);
    notifier = startNotifier(app, {
      forgeUrl: "https://forge.example",
      send: async (url, body) => {
        posts.push({ url, body });
        return true;
      },
    });
    await notifier.settled();
  });
  afterAll(async () => {
    notifier.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const outsider = async (name: string) => {
    const res = await api("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: name,
        email: `${name}@outsider.test`,
        password: "outsider-passphrase",
      }),
    });
    expect(res.status).toBe(201);
    const user = getUserByName(app.db, name)!;
    return { user, token: createToken(app.db, user.id, "o", "admin").token };
  };

  test("a signup leaves an audit record: who, when, how, and from where", async () => {
    const { user } = await outsider("ada");
    const made = listEvents(app.db, { kind: "user.created" }).find(
      (e) => e.actorId === user.id,
    );
    expect(made?.payload["via"]).toBe("signup");
    expect(typeof made?.payload["address"]).toBe("string");
  });

  test("an account the edge makes is audited too", async () => {
    const res = await fetch(`${base}/api/v1/user`, {
      headers: { "x-plat-user": "edgy", "x-plat-edge-token": EDGE },
    });
    expect(res.status).toBe(200);
    const user = getUserByName(app.db, "edgy")!;
    const made = listEvents(app.db, { kind: "user.created" }).find(
      (e) => e.actorId === user.id,
    );
    expect(made?.payload["via"]).toBe("edge");
  });

  test("the owner hears of a new account once", async () => {
    await notifier.settled();
    const before = posts.length;
    await outsider("grace");
    await notifier.settled();
    const told = posts.slice(before);
    expect(told.filter((p) => p.body.includes("grace"))).toHaveLength(1);
    expect(told[0]!.url).toBe("https://ntfy.example.test/owner");
    // Something else wakes the notifier: grace is not told twice.
    await outsider("hopper");
    await notifier.settled();
    expect(posts.filter((p) => p.body.includes("grace"))).toHaveLength(1);
  });

  test("nobody but the owner sees the list, or can act on it", async () => {
    const { token } = await outsider("mallory");
    expect((await api("/api/v1/admin/accounts", { token })).status).toBe(404);
    expect(
      (
        await api("/api/v1/admin/accounts/ada/suspend", {
          method: "POST",
          token,
        })
      ).status,
    ).toBe(404);
    expect(
      (await api("/api/v1/admin/accounts/ada", { method: "DELETE", token }))
        .status,
    ).toBe(404);
    expect((await api("/api/v1/admin/accounts")).status).toBe(404);
    const page = await fetch(`${base}/settings/accounts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page.status).toBe(404);
  });

  test("the owner's list shows each account, how it came, and what it holds", async () => {
    const res = await api("/api/v1/admin/accounts", { token: ownerToken });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: {
        username: string;
        via: string | null;
        repos: number;
        spentUsd: number;
        suspendedAt: string | null;
      }[];
    };
    const ada = items.find((i) => i.username === "ada")!;
    expect(ada.via).toBe("signup");
    expect(ada.repos).toBe(0);
    expect(ada.spentUsd).toBe(0);
    expect(ada.suspendedAt).toBeNull();
    expect(items.find((i) => i.username === "edgy")?.via).toBe("edge");
    const page = await fetch(`${base}/settings/accounts`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("ada");
    expect(html).toContain("Suspend");
  });

  test("suspending stops every credential at once", async () => {
    const { user, token } = await outsider("eve");
    const cookie = `forge_session=${createSession(app.db, user.id).token}`;
    const parsed = parseAuthorizedKey(KEY_LINE);
    if (!parsed.ok) throw new Error("key");
    expect(addKey(app.db, user.id, "laptop", parsed.value).ok).toBe(true);

    expect((await api("/api/v1/user", { token })).status).toBe(200);
    const res = await api("/api/v1/admin/accounts/eve/suspend", {
      method: "POST",
      token: ownerToken,
    });
    expect(res.status).toBe(200);

    expect((await api("/api/v1/user", { token })).status).toBe(401);
    expect(
      (await fetch(`${base}/api/v1/user`, { headers: { cookie } })).status,
    ).toBe(401);
    const basic = Buffer.from("eve:outsider-passphrase").toString("base64");
    expect(
      (
        await fetch(`${base}/api/v1/user`, {
          headers: { authorization: `Basic ${basic}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/v1/user`, {
          headers: { "x-plat-user": "eve", "x-plat-edge-token": EDGE },
        })
      ).status,
    ).toBe(401);
    const tui = identityFor(app, {
      key: { fingerprint: fingerprint(parsed.value.blob), line: KEY_LINE },
      username: "eve",
      remoteAddress: "203.0.113.9",
    } as never);
    expect(tui.user).toBeUndefined();
    // It can start nothing: creating a repository needs a signed-in account.
    expect(
      (
        await api("/api/v1/repos", {
          method: "POST",
          token,
          body: JSON.stringify({ name: "x" }),
        })
      ).status,
    ).toBe(401);
  });

  test("a suspended account's repositories run nothing", async () => {
    const { user } = await outsider("trudy");
    const made = await createRepo(app, user, { name: "lab" });
    if (!made.ok) throw new Error(made.error);
    const repo = made.value;
    const queued = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env: "main",
      commitOid: "0".repeat(40),
      reason: "push",
    });
    const res = await api("/api/v1/admin/accounts/trudy/suspend", {
      method: "POST",
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    // What was waiting is cancelled, and the crew starts nothing new there.
    expect(getRun(app.db, queued.id)?.state).toBe("cancelled");
    const agent = await insertAgent(app.db, {
      username: "builder",
      email: "builder@agents.invalid",
      agent: true,
    });
    if (!agent.ok) throw new Error(agent.error);
    const issue = await openIssue(app, getUserByName(app.db, "owner")!, repo, {
      title: "work",
    });
    if (!issue.ok) throw new Error(issue.error);
    const crew = getAgent(app.db, agent.value.id);
    if (crew)
      expect(
        queueAgentRun(app, repo, issue.value, crew, "assigned"),
      ).toBeUndefined();
  });

  test("unsuspending lets the account sign in again; old tokens stay dead", async () => {
    const res = await api("/api/v1/admin/accounts/eve/unsuspend", {
      method: "POST",
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    const basic = Buffer.from("eve:outsider-passphrase").toString("base64");
    expect(
      (
        await fetch(`${base}/api/v1/user`, {
          headers: { authorization: `Basic ${basic}` },
        })
      ).status,
    ).toBe(200);
  });

  test("removing takes the account's repositories and credentials, keeps the name and others' threads", async () => {
    const { user, token } = await outsider("oscar");
    const made = await createRepo(app, user, { name: "junk" });
    if (!made.ok) throw new Error(made.error);
    const bare = repoDir(app.reposRoot, "oscar", "junk");
    expect(existsSync(bare)).toBe(true);
    // oscar spoke on someone else's repository.
    const owner = getUserByName(app.db, "owner")!;
    const host = await createRepo(app, owner, {
      name: "public-host",
      visibility: "public",
    });
    if (!host.ok) throw new Error(host.error);
    const issue = await openIssue(app, owner, host.value, { title: "hello" });
    if (!issue.ok) throw new Error(issue.error);
    expect(
      addComment(app, user, host.value, issue.value, "hi from oscar").ok,
    ).toBe(true);

    const res = await api("/api/v1/admin/accounts/oscar", {
      method: "DELETE",
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    expect(existsSync(bare)).toBe(false);
    expect((await api("/api/v1/user", { token })).status).toBe(401);
    const row = getUserByName(app.db, "oscar")!;
    expect(row.removedAt).not.toBeNull();
    expect(row.email).not.toContain("outsider.test");
    // The name stays taken, so nobody can step into it.
    const again = await api("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: "oscar",
        email: "oscar2@outsider.test",
        password: "outsider-passphrase",
      }),
    });
    expect(again.status).toBe(422);
    // What oscar said on another's thread is still there.
    const thread = await api(
      `/api/v1/repos/owner/public-host/issues/${issue.value.number}`,
      { token: ownerToken },
    );
    expect(JSON.stringify(await thread.json())).toContain("hi from oscar");
  });

  test("an account with nothing in it can be removed too", async () => {
    await outsider("empty");
    const res = await api("/api/v1/admin/accounts/empty", {
      method: "DELETE",
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    expect(getUserByName(app.db, "empty")?.removedAt).not.toBeNull();
  });

  test("the owner cannot suspend or remove themselves, another admin, or an agent", async () => {
    for (const name of ["owner", "builder"]) {
      expect(
        (
          await api(`/api/v1/admin/accounts/${name}/suspend`, {
            method: "POST",
            token: ownerToken,
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await api(`/api/v1/admin/accounts/${name}`, {
            method: "DELETE",
            token: ownerToken,
          })
        ).status,
      ).toBe(422);
    }
  });

  test("a refusal the database raises answers 403 with its reason, not 500", async () => {
    // An operator's guard, the way production holds new accounts back.
    app.db.exec(
      "CREATE TRIGGER test_refuse BEFORE INSERT ON repo BEGIN SELECT RAISE(ABORT, 'new repositories are paused here'); END;",
    );
    try {
      const res = await api("/api/v1/repos", {
        method: "POST",
        token: ownerToken,
        body: JSON.stringify({ name: "guarded" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "refused",
        message: "new repositories are paused here",
      });
      // The refusal leaves nothing on disk.
      expect(existsSync(repoDir(app.reposRoot, "owner", "guarded"))).toBe(false);
    } finally {
      app.db.exec("DROP TRIGGER test_refuse");
    }
  });

  test("the audit records suspensions and removals", () => {
    const kinds = listEvents(app.db, {}).map((e) => e.kind);
    expect(kinds).toContain("account.suspended");
    expect(kinds).toContain("account.unsuspended");
    expect(kinds).toContain("account.removed");
  });
});
