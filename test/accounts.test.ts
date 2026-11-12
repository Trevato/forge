import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setLimit } from "../src/settings/limits.ts";
import {
  startNotifier,
  setNotifyUrl,
  type Notifier,
} from "../src/crew/notify.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { fetchInternal } from "../src/git/hook-address.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { newAccountLines } from "../src/actions/accounts.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createOrg } from "../src/core/orgs.ts";
import { getAgent } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { repoDir } from "../src/git/repos.ts";
import { listReposOwnedBy } from "../src/core/repos.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser as insertAgent, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeSshSession, identityFor } from "../src/tui/ssh.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { seedAdmin } from "./helpers/admin.ts";

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
    setLimit(app.db, "signup.per_source", 1000, "setup");
    base = servers.url;
    const owner = await seedAdmin(app, {
      username: "olive",
      email: "olive@f.dev",
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
    await notifier.close();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const outsider = async (name: string) => {
    const res = await api("/api/v1/users", {
      method: "POST",
      headers: { "x-plat-user": name, "x-plat-edge-token": EDGE },
      body: JSON.stringify({
        username: name,
        email: `${name}@outsider.test`,
        password: "outsider-passphrase",
      }),
    });
    expect(res.status).toBe(201);
    // This suite is about standing, not email: its outsiders are proven.
    proveAll(app);
    const user = getUserByName(app.db, name)!;
    // Nor about roles: its outsiders are members (`test/guests.test.ts`).
    promote(app.db, user);
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

  test("an unknown edge login makes no account and no audit record; an old edge account still signs in", async () => {
    const as = (login: string) =>
      fetch(`${base}/api/v1/user`, {
        headers: { "x-plat-user": login, "x-plat-edge-token": EDGE },
      });
    const before = listEvents(app.db, { kind: "user.created" }).length;
    expect((await as("edgy")).status).toBe(401);
    expect(getUserByName(app.db, "edgy")).toBeUndefined();
    expect(listEvents(app.db, { kind: "user.created" }).length).toBe(before);
    // An account the edge made when it still did, audited as it was then.
    const old = await insertAgent(app.db, {
      origin: "edge",
      username: "edgy",
      email: "edgy@forge.example",
    });
    if (!old.ok) throw new Error(old.error);
    app.bus.append({ kind: "user.created", actorId: old.value.id, payload: { via: "edge", address: "127.0.0.1" } });
    expect((await as("edgy")).status).toBe(200);
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
    expect((await api("/api/v1/admin/accounts", { token })).status).toBe(403);
    expect(
      (
        await api("/api/v1/admin/accounts/ada/suspend", {
          method: "POST",
          token,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("/api/v1/admin/accounts/ada", { method: "DELETE", token }))
        .status,
    ).toBe(403);
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
        signsInThrough: string | null;
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
    expect(items.find((i) => i.username === "edgy")?.signsInThrough).toBe("open-platform.sh");
    expect(ada.signsInThrough).toBeNull();
    const page = await fetch(`${base}/settings/accounts`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("ada");
    expect(html).toContain("Suspend");
    expect(html).toContain("signs in through open-platform.sh");
    expect(html.match(/signs in through/g)?.length).toBe(1);
    const owner = getUserByName(app.db, "olive")!;
    const lines = newAccountLines(app.db, owner).map((l) => l.line);
    expect(lines).toContain("edgy joined the forge (signs in through open-platform.sh)");
    expect(lines).toContain("ada joined the forge (signup)");
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

  test("an SSH terminal already open ends when its account is suspended", async () => {
    const { user } = await outsider("walter");
    const parsed = parseAuthorizedKey(KEY_LINE.replace("outsider", "walter"));
    if (!parsed.ok) throw new Error("key");
    // A second key line for a second account: the same blob cannot be on two.
    app.db.query("DELETE FROM user_key WHERE name = 'laptop'").run();
    expect(addKey(app.db, user.id, "desk", parsed.value).ok).toBe(true);
    const closers: (() => void)[] = [];
    let exited: number | undefined;
    let stderr = "";
    const session = {
      key: { fingerprint: fingerprint(parsed.value.blob), line: KEY_LINE },
      username: "walter",
      remoteAddress: "203.0.113.9",
      kind: "shell" as const,
      command: undefined,
      term: "xterm-256color",
      env: {},
      cols: 80,
      rows: 24,
      widthPx: 0,
      heightPx: 0,
      ended: false,
      pending: 0,
      write() {},
      writeStderr(data: Uint8Array | string) {
        stderr += String(data);
      },
      onData() {},
      onResize() {},
      onEof() {},
      onClose(cb: () => void) {
        closers.push(cb);
      },
      // Like a real channel: the first exit closes it; later ones are no-ops.
      exit(code: number) {
        if (exited !== undefined) return;
        exited = code;
        for (const cb of closers) cb();
      },
      drained: async () => {},
    };
    forgeSshSession(app)(session as never);
    expect(exited).toBeUndefined();
    const res = await api("/api/v1/admin/accounts/walter/suspend", {
      method: "POST",
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    expect(exited).toBe(1);
    expect(stderr).toContain("suspended");
  });

  test("a live event stream already open ends when its account is suspended", async () => {
    const { token } = await outsider("stella");
    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(": connected");
    const suspended = await api("/api/v1/admin/accounts/stella/suspend", {
      method: "POST",
      token: ownerToken,
    });
    expect(suspended.status).toBe(200);
    // Whatever was queued may still arrive; then the stream ends, well
    // before its next heartbeat.
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return true;
    })();
    expect(
      await Promise.race([ended, Bun.sleep(5_000).then(() => false)]),
    ).toBe(true);
  });

  test("a stream of someone else's stays open when one account is suspended", async () => {
    const { token } = await outsider("otto");
    await outsider("pia");
    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const reader = res.body!.getReader();
    await reader.read();
    const suspended = await api("/api/v1/admin/accounts/pia/suspend", {
      method: "POST",
      token: ownerToken,
    });
    expect(suspended.status).toBe(200);
    const next = await Promise.race([
      reader.read().then((r) => (r.done ? "ended" : "data")),
      Bun.sleep(500).then(() => "open"),
    ]);
    expect(next).not.toBe("ended");
    await reader.cancel();
  });

  test("a push under way when its account is suspended does not land", async () => {
    const { user } = await outsider("pusher");
    const made = await createRepo(app, user, { name: "midway" });
    if (!made.ok) throw new Error(made.error);
    // What git's pre-receive hook asks the forge once the pack is in: the
    // ref update, from the account that pushed it.
    const ask = () =>
      fetchInternal(app.hookAddress.current, "/internal/hook", {
        method: "POST",
        headers: { "x-forge-hook-secret": app.hookSecret },
        body: JSON.stringify({
          hook: "pre-receive",
          repoId: made.value.id,
          actorId: user.id,
          updates: [
            {
              ref: "refs/heads/feature",
              oldOid: "0".repeat(40),
              newOid: "1".repeat(40),
            },
          ],
          gitEnv: {},
        }),
      });
    expect((await ask()).status).toBe(200);
    const suspended = await api("/api/v1/admin/accounts/pusher/suspend", {
      method: "POST",
      token: ownerToken,
    });
    expect(suspended.status).toBe(200);
    const refused = await ask();
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("suspended");
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
      origin: "seed",
      username: "builder",
      email: "builder@agents.invalid",
      agent: true,
    });
    if (!agent.ok) throw new Error(agent.error);
    const issue = await openIssue(app, getUserByName(app.db, "olive")!, repo, {
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
    const owner = getUserByName(app.db, "olive")!;
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
      headers: { "x-plat-user": "oscar", "x-plat-edge-token": EDGE },
      body: JSON.stringify({
        username: "oscar",
        email: "oscar2@outsider.test",
        password: "outsider-passphrase",
      }),
    });
    expect(again.status).toBe(422);
    // What oscar said on another's thread is still there.
    const thread = await api(
      `/api/v1/repos/olive/public-host/issues/${issue.value.number}`,
      { token: ownerToken },
    );
    expect(JSON.stringify(await thread.json())).toContain("hi from oscar");
  });

  test("retiring a last owner's organizations needs retireOrgs and an explicit confirm", async () => {
    const { user: boss, token: bossToken } = await outsider("rex");
    const org = createOrg(app.db, "rexco", boss.id);
    if (!org.ok) throw new Error(org.error);
    const made = await createRepo(app, org.value, { name: "ledger" });
    if (!made.ok) throw new Error(made.error);
    const bare = repoDir(app.reposRoot, "rexco", "ledger");
    const mine = await createRepo(app, boss, { name: "diary" });
    if (!mine.ok) throw new Error(mine.error);
    expect(existsSync(bare)).toBe(true);
    const del = (payload: object, token = ownerToken) =>
      api("/api/v1/admin/accounts/rex", {
        method: "DELETE",
        token,
        body: JSON.stringify(payload),
      });

    // The plain path is as it was.
    expect((await del({})).status).toBe(409);
    // A non-admin is refused.
    expect((await del({ retireOrgs: true, confirm: true }, bossToken)).status).toBe(403);
    // Without confirm: the list, and nothing changes.
    const preview = await del({ retireOrgs: true });
    expect(preview.status).toBe(200);
    const plan = (await preview.json()) as { own: { name: string; app: string | null }[]; retire: { org: string; repos: { name: string }[]; teams: string[] }[] };
    expect(plan.retire[0]!.org).toBe("rexco");
    expect(plan.retire[0]!.repos.map((r) => r.name)).toEqual(["rexco/ledger"]);
    expect(plan.retire[0]!.teams).toEqual(["Owners"]);
    expect(plan.own).toEqual([{ name: "rex/diary", app: null }]);
    expect(existsSync(bare)).toBe(true);
    expect(getUserByName(app.db, "rex")?.removedAt).toBeNull();
    expect(getUserByName(app.db, "rexco")?.removedAt).toBeNull();

    // Confirmed: everything goes, and the bus remembers.
    const done = await del({ retireOrgs: true, confirm: true });
    expect(done.status).toBe(200);
    expect(existsSync(bare)).toBe(false);
    expect(getUserByName(app.db, "rexco")?.removedAt).not.toBeNull();
    expect(getUserByName(app.db, "rex")?.removedAt).not.toBeNull();
    const kinds = listEvents(app.db, {}).map((e) => e.kind);
    expect(kinds).toContain("org.retired");
    expect(kinds).toContain("account.removed");
    expect(kinds).toContain("repo.deleted");
  });

  test("a retirement that stops partway says what went, keeps the rest, and a second call finishes", async () => {
    const { user: boss } = await outsider("sam");
    const org = createOrg(app.db, "samco", boss.id);
    if (!org.ok) throw new Error(org.error);
    for (const name of ["one", "two"]) {
      const made = await createRepo(app, org.value, { name });
      if (!made.ok) throw new Error(made.error);
    }
    const order = listReposOwnedBy(app.db, org.value.id).map((r) => r.name);
    const [first, second] = order as [string, string];
    // The second repository's directory is gone, so it cannot be removed.
    const secondDir = repoDir(app.reposRoot, "samco", second);
    const parked = `${secondDir}.parked`;
    renameSync(secondDir, parked);
    const del = () =>
      api("/api/v1/admin/accounts/sam", {
        method: "DELETE",
        token: ownerToken,
        body: JSON.stringify({ retireOrgs: true, confirm: true }),
      });

    const failed = await del();
    expect(failed.status).toBe(500);
    const result = (await failed.json()) as { failed: string; removed: string[] };
    expect(result.failed).toBe(`samco/${second}`);
    expect(result.removed).toEqual([`samco/${first}`]);
    expect(existsSync(repoDir(app.reposRoot, "samco", first))).toBe(false);
    expect(getUserByName(app.db, "samco")?.removedAt).toBeNull();
    expect(getUserByName(app.db, "sam")?.removedAt).toBeNull();
    expect(getUserByName(app.db, "sam")?.suspendedAt).not.toBeNull();

    // Call again: the repository's row went with the first attempt, so the
    // job finishes.
    const again = await del();
    expect(again.status).toBe(200);
    expect(listReposOwnedBy(app.db, org.value.id)).toEqual([]);
    expect(getUserByName(app.db, "samco")?.removedAt).not.toBeNull();
    expect(getUserByName(app.db, "sam")?.removedAt).not.toBeNull();
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
    for (const name of ["olive", "builder"]) {
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
      "CREATE TRIGGER test_refuse BEFORE INSERT ON repo BEGIN SELECT RAISE(ABORT, 'forge: new repositories are paused here'); END;",
    );
    try {
      const res = await api("/api/v1/repos", {
        method: "POST",
        token: ownerToken,
        body: JSON.stringify({ name: "guarded" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "refused",
        message: "forge: new repositories are paused here",
      });
      // The refusal leaves nothing on disk.
      expect(existsSync(repoDir(app.reposRoot, "olive", "guarded"))).toBe(false);
    } finally {
      app.db.exec("DROP TRIGGER test_refuse");
    }
  });

  test("a refusal without the forge: prefix is answered generically to anyone, and logged in full (#723)", async () => {
    const secret = "constraint on table repo_internal_x failed";
    app.db.exec(
      `CREATE TRIGGER test_refuse_plain BEFORE INSERT ON repo BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
    );
    const logged: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const log = app.log;
    (app as { log: typeof log }).log = {
      ...log,
      warn: (message, fields) => {
        logged.push({ message, fields });
        log.warn(message, fields);
      },
    };
    try {
      const res = await api("/api/v1/repos", {
        method: "POST",
        token: ownerToken,
        body: JSON.stringify({ name: "guarded-plain" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "refused",
        message: "refused",
      });
      expect(
        logged.some((l) => l.fields?.reason === secret),
      ).toBe(true);
    } finally {
      (app as { log: typeof log }).log = log;
      app.db.exec("DROP TRIGGER test_refuse_plain");
    }
  });

  test("the owner can verify a newcomer's email, and it can create at once", async () => {
    // Made first: the helper proves every account waiting on a link.
    const { token: other } = await outsider("mallet");
    // A way in that vouches for nothing: the account starts unproven.
    const made = await insertAgent(app.db, {
      origin: "seed",
      username: "nadia",
      email: "nadia@outsider.test",
      password: "outsider-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    const token = createToken(app.db, made.value.id, "t", "admin").token;
    const create = () =>
      api("/api/v1/repos", { method: "POST", token, body: JSON.stringify({ name: "first" }) });
    expect((await create()).status).toBe(403);

    // Nobody but the owner may say so.
    expect(
      (await api("/api/v1/admin/accounts/nadia/verify", { method: "POST", token: other })).status,
    ).toBe(403);

    const listed = (await (await api("/api/v1/admin/accounts", { token: ownerToken })).json()) as {
      items: { username: string; verified: boolean }[];
    };
    expect(listed.items.find((i) => i.username === "nadia")?.verified).toBe(false);
    const page = await fetch(`${base}/settings/accounts`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const html = await page.text();
    expect(html).toContain("Verify email");
    expect(html).toContain("Mail is not configured");

    const res = await api("/api/v1/admin/accounts/nadia/verify", { method: "POST", token: ownerToken });
    expect(res.status).toBe(200);
    expect((await create()).status).toBe(201);
    expect(
      listEvents(app.db, { kind: "account.email_verified" }).some(
        (e) => e.payload["username"] === "nadia" && e.payload["by"] === "owner",
      ),
    ).toBe(true);
  });

  test("the owner cannot verify an agent", async () => {
    expect(
      (await api("/api/v1/admin/accounts/builder/verify", { method: "POST", token: ownerToken })).status,
    ).toBe(422);
  });

  test("the audit records suspensions and removals", () => {
    const kinds = listEvents(app.db, {}).map((e) => e.kind);
    expect(kinds).toContain("account.suspended");
    expect(kinds).toContain("account.unsuspended");
    expect(kinds).toContain("account.removed");
  });
});
