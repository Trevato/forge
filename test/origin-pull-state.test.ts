import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch } from "../src/actions/repos.ts";
import { forkRepo } from "../src/actions/repos.ts";
import { proposeUpstream } from "../src/actions/upstream.ts";
import { createApp, type App } from "../src/app.ts";
import { getOriginById } from "../src/core/origins.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hookSecret, HOOK_SIGNATURE_HEADER } from "../src/origins/hook.ts";
import { originCheckOf } from "../src/origins/pull-check.ts";
import { syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

/**
 * A pull proposed from a fork of a mirror opens on the origin (#8965), and
 * how its check and reviews stand there comes back: on the origin's signed
 * webhook at once, by the poll when the webhook never arrived, and again
 * after the origin has been down.
 */

setDefaultTimeout(60_000);

const ALICE = "alice-login-secret";
const BOB = "bob-login-secret";
const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("a pull proposed to an origin forge", () => {
  const dirs: string[] = [];
  let mine: App;
  let friend: App;
  let mineServers: Servers;
  let friendServers: Servers;
  let originId = "";
  let number = 0;

  const mineApi = (path: string, init: RequestInit = {}) =>
    fetch(`${mineServers.url}${path}`, {
      ...init,
      headers: {
        authorization: basic("alice", ALICE),
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const bobApi = (path: string, init: RequestInit = {}) =>
    fetch(`${friendServers.url}${path}`, {
      ...init,
      headers: { authorization: basic("bob", BOB), "content-type": "application/json" },
    });
  const mirror = () => getRepo(mine.db, "alice", "app")!;
  const sync = () => syncOrigin(mine, getOriginById(mine.db, originId)!);
  const ours = () => getPull(mine.db, mirror().id, number)!;

  /** The origin runs a check of the pull's head, and it ends as `state`. */
  const checkOnOrigin = (state: "ok" | "failed") => {
    const bob = getRepo(friend.db, "bob", "app")!;
    const issue = friend.db
      .query<{ id: string; head_oid: string }, [string, number]>(
        "SELECT i.id, p.head_oid FROM issue i JOIN pull p ON p.issue_id = i.id WHERE i.repo_id = ?1 AND i.number = ?2",
      )
      .get(bob.id, number)!;
    friend.db.query("DELETE FROM run WHERE issue_id = ?1").run(issue.id);
    friend.db
      .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, ?5)")
      .run(`run-${state}`, bob.id, issue.id, issue.head_oid, state);
  };

  const deliver = async (body: unknown, secret = hookSecret(mine, mirror())) => {
    const raw = JSON.stringify(body);
    const mac = new Bun.CryptoHasher("sha256", secret).update(raw).digest("hex");
    return fetch(`${mineServers.url}/api/v1/repos/alice/app/origin-hook`, {
      method: "POST",
      headers: { "content-type": "application/json", [HOOK_SIGNATURE_HEADER]: `sha256=${mac}` },
      body: raw,
    });
  };

  beforeAll(async () => {
    const make = async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-origin-pull-"));
      dirs.push(dir);
      return dir;
    };
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const friendPort = probe.port as number;
    await probe.stop(true);
    friend = createApp({ dataDir: await make(), port: friendPort });
    friendServers = await serve(friend);
    await seedAdmin(friend, { username: "bob", email: "bob@friend.test", password: BOB });
    proveAll(friend);
    const token = createToken(friend.db, getUserByName(friend.db, "bob")!.id, "alice", "admin").token;
    await bobApi("/api/v1/repos", { method: "POST", body: JSON.stringify({ name: "app", visibility: "public" }) });
    await bobApi("/api/v1/repos/bob/app/contents", {
      method: "POST",
      body: JSON.stringify({ branch: "main", message: "first", files: [{ path: "README.md", content: "app\n" }] }),
    });

    mine = createApp({ dataDir: await make(), port: 0, url: "https://mine.test" });
    mineServers = await serve(mine);
    await seedAdmin(mine, { username: "alice", email: "alice@forge.test", password: ALICE });
    proveAll(mine);
    const connected = await mineApi("/api/v1/user/origins", {
      method: "POST",
      body: JSON.stringify({ host: friendServers.url, token }),
    });
    originId = ((await connected.json()) as { id: string }).id;
    const job = await mirrorAndWait(
      await mineApi(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "bob/app" }),
      }),
    );
    expect(job?.stage).toBe("done");
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    mineServers.stop();
    friendServers.stop();
    mine.close();
    friend.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("Propose upstream from a fork opens the pull on the origin with the author kept, and asks for its events", async () => {
    const alice = getUserByName(mine.db, "alice")!;
    const fork = await forkRepo(mine, alice, mirror(), "app-mine");
    if (!fork.ok) throw new Error(JSON.stringify(fork.error));
    const edited = await commitToBranch(mine, alice, fork.value, {
      branch: "main",
      base: "main",
      message: "my change",
      files: [{ path: "NOTE.md", content: "mine\n" }],
    });
    if (!edited.ok) throw new Error(JSON.stringify(edited.error));
    const proposed = await proposeUpstream(mine, alice, fork.value);
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    expect(proposed.value.opened).toBe(true);
    number = proposed.value.pull.number;

    const there = await (await bobApi(`/api/v1/repos/bob/app/pulls/${number}`)).json();
    expect(there).toMatchObject({ headBranch: "alice/main", baseBranch: "main", state: "open" });
    expect(getPull(mine.db, mirror().id, number)?.originUrl).toContain(`/bob/app/pulls/${number}`);

    // The commit that arrived keeps its author.
    const commits = (await (await bobApi("/api/v1/repos/bob/app/commits?ref=alice/main&limit=1")).json()) as { author: string; subject: string }[];
    expect(commits[0]).toMatchObject({ author: "alice", subject: "my change" });

    // Asking for the hook is off the request path: it lands shortly after.
    let hooks = "";
    for (let i = 0; i < 50 && !hooks.includes("/alice/app/origin-hook"); i++) {
      hooks = JSON.stringify(await (await bobApi("/api/v1/repos/bob/app/hooks")).json());
      if (!hooks.includes("/alice/app/origin-hook")) await Bun.sleep(100);
    }
    expect(hooks).toContain("https://mine.test/api/v1/repos/alice/app/origin-hook");
  });

  test("a webhook from the origin brings the check and a review at once", async () => {
    checkOnOrigin("ok");
    const review = await fetch(`${friendServers.url}/api/v1/repos/bob/app/pulls/${number}/review-states`, {
      method: "POST",
      headers: { authorization: basic("bob", BOB), "content-type": "application/json" },
      body: JSON.stringify({ state: "changes_requested", body: "not yet" }),
    });
    expect(review.status).toBe(201);
    expect((await deliver({ kind: "run.finished", payload: { number } }, "wrong")).status).toBe(404);
    expect(originCheckOf(mine.db, ours().id)).toBeUndefined();

    expect((await deliver({ kind: "run.finished", payload: { number } })).status).toBe(200);
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("green");
    const page = await (await mineApi(`/alice/app/pulls/${number}`)).text();
    expect(page.replace(/\s+/g, " ")).toContain("passing");
    const reviews = mine.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review WHERE issue_id = ?1 AND state = 'changes_requested'")
      .get(ours().id)!;
    expect(reviews.n).toBe(1);
  });

  test("the poll catches a change whose webhook never came", async () => {
    checkOnOrigin("failed");
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("green");
    // A settled pull is read again by the poll once it has not been for an hour.
    await sync();
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("green");
    mine.db.query("UPDATE origin_pull_check SET checked_at = '2020-01-01T00:00:00.000Z'").run();
    await sync();
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("red");
  });

  test("the origin down for a while leaves the last word standing, and it catches up when back", async () => {
    friendServers.stop();
    const report = await sync();
    expect(report.error).not.toBe("");
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("red");
    expect((await mineApi(`/alice/app/pulls/${number}`)).status).toBe(200);

    friendServers = await serve(friend);
    checkOnOrigin("ok");
    mine.db.query("UPDATE origin_pull_check SET checked_at = '2020-01-01T00:00:00.000Z'").run();
    expect((await sync()).error).toBe("");
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("green");
  });

  test("a signed delivery that names no pull re-reads nothing", async () => {
    checkOnOrigin("failed");
    expect((await deliver({ kind: "push" })).status).toBe(200);
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("green");
    expect((await deliver({ kind: "run.finished", payload: { number } })).status).toBe(200);
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("red");
    // A settled pull is not read by the sweep either.
    checkOnOrigin("ok");
    expect((await sync()).error).toBe("");
    expect(originCheckOf(mine.db, ours().id)?.word).toBe("red");
  });

  test("a delivery that is unsigned, or for a repository with no origin, is the same 404", async () => {
    const unsigned = await fetch(`${mineServers.url}/api/v1/repos/alice/app/origin-hook`, { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(404);
    const none = await fetch(`${mineServers.url}/api/v1/repos/alice/app-mine/origin-hook`, { method: "POST", body: "{}" });
    expect(none.status).toBe(404);
  });
});
