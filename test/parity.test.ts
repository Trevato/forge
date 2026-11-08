/**
 * Parity pass: everything a UI needs to give full control of the platform
 * is reachable through actions and the JSON API — profile and password,
 * default branch, pull close/reopen, labels, reviews, tokens, orgs and
 * teams, cross-repo pulls, tags/commits/forks, pagination and filters, and
 * an event for every mutation. Adversarial where authorization matters.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { createSession, pruneSessions } from "../src/core/sessions.ts";
import { getRepo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@forge.test",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@forge.test",
});

async function git(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...gitEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, errText, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${errText}`);
  return out.trim();
}

type Json = Record<string, unknown>;
const PASS = "a-long-passphrase";

describe("parity: full control through actions and the API", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let aliceRw = "";
  let aliceAdmin = "";
  let aliceRo = "";
  let bobRw = "";
  let aliceCookie = "";

  const basic = (user: string) =>
    `Basic ${Buffer.from(`${user}:${PASS}`).toString("base64")}`;

  async function call(
    method: string,
    path: string,
    options: {
      token?: string;
      auth?: string;
      cookie?: string;
      body?: unknown;
    } = {},
  ): Promise<{ status: number; json: Json; list: Json[] }> {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.auth) headers.authorization = options.auth;
    if (options.cookie) headers.cookie = options.cookie;
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return {
      status: res.status,
      json: (Array.isArray(parsed) ? {} : parsed) as Json,
      list: (Array.isArray(parsed) ? parsed : []) as Json[],
    };
  }

  const mint = async (user: string, scope: "ro" | "rw" | "admin") => tokenFor(app, user, scope, scope);

  const kinds = () =>
    listEvents(app.db, { limit: 1000 })
      .map((e) => e.kind)
      .reverse();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-parity-"));
    work = await mkdtemp(join(tmpdir(), "forge-parity-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    for (const username of ["alice", "bob", "carol"]) {
      const res = await call("POST", "/api/v1/users", {
        body: { username, email: `${username}@forge.test`, password: PASS },
      });
      expect(res.status).toBe(201);
    }
    proveAll(app);
    promote(app.db);
    aliceRw = await mint("alice", "rw");
    aliceAdmin = await mint("alice", "admin");
    aliceRo = await mint("alice", "ro");
    bobRw = await mint("bob", "rw");
    const session = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: PASS }),
    });
    aliceCookie = session.headers.get("set-cookie")!.split(";")[0]!;

    // alice/pub: main with two commits, a feature branch one commit ahead.
    expect(
      (
        await call("POST", "/api/v1/repos", {
          token: aliceRw,
          body: { name: "pub", visibility: "public" },
        })
      ).status,
    ).toBe(201);
    for (const [message, content] of [
      ["first", "alpha\nbeta\ngamma\n"],
      ["second", "alpha\nbeta\ngamma\ndelta\n"],
    ]) {
      await call("POST", "/api/v1/repos/alice/pub/contents", {
        token: aliceRw,
        body: { message, files: [{ path: "code.txt", content }] },
      });
    }
    await call("POST", "/api/v1/repos/alice/pub/contents", {
      token: aliceRw,
      body: {
        branch: "feature",
        message: "feature",
        files: [{ path: "code.txt", content: "alpha\nBETA\ngamma\ndelta\n" }],
      },
    });
    await call("POST", "/api/v1/repos", {
      token: aliceRw,
      body: { name: "secret", visibility: "private" },
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  // ── profile & password ───────────────────────────────────────────────

  test("public profiles, and profile edits only with the account itself", async () => {
    const profile = await call("GET", "/api/v1/users/alice");
    expect(profile.status).toBe(200);
    expect(profile.json).toMatchObject({ username: "alice", kind: "user" });
    expect(profile.json.email).toBeUndefined();
    expect(typeof profile.json.createdAt).toBe("string");
    expect((await call("GET", "/api/v1/users/nobody")).status).toBe(404);

    // An rw token is not the account; an admin token or the session is.
    expect(
      (
        await call("PATCH", "/api/v1/user", {
          token: aliceRw,
          body: { displayName: "Nope" },
        })
      ).status,
    ).toBe(403);
    const viaAdmin = await call("PATCH", "/api/v1/user", {
      token: aliceAdmin,
      body: { displayName: "Alice A." },
    });
    expect(viaAdmin.status).toBe(200);
    expect(viaAdmin.json.displayName).toBe("Alice A.");
    const viaSession = await call("PATCH", "/api/v1/user", {
      cookie: aliceCookie,
      body: { email: "alice@new.test" },
    });
    expect(viaSession.status).toBe(200);
    const taken = await call("PATCH", "/api/v1/user", {
      cookie: aliceCookie,
      body: { email: "bob@forge.test" },
    });
    expect(taken.status).toBe(422);
    expect(taken.json.error).toBe("email_taken");
    expect(
      (
        await call("PATCH", "/api/v1/user", {
          cookie: aliceCookie,
          body: { email: "not-an-email" },
        })
      ).json.error,
    ).toBe("invalid_email");
    expect(kinds().filter((k) => k === "user.updated")).toHaveLength(2);
  });

  test("changing the password needs the current one and never an rw token", async () => {
    expect(
      (
        await call("POST", "/api/v1/user/password", {
          token: aliceRw,
          body: { current: PASS, next: "another-long-pass" },
        })
      ).status,
    ).toBe(403);
    const wrong = await call("POST", "/api/v1/user/password", {
      cookie: aliceCookie,
      body: { current: "wrong-password!", next: "another-long-pass" },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error).toBe("bad_credentials");
    const weak = await call("POST", "/api/v1/user/password", {
      cookie: aliceCookie,
      body: { current: PASS, next: "short" },
    });
    expect(weak.status).toBe(422);
    expect(weak.json.error).toBe("weak_password");

    // Carol rotates for real, then signs in with the new one only.
    const carolCookie = (
      await fetch(`${base}/api/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "carol", password: PASS }),
      })
    ).headers
      .get("set-cookie")!
      .split(";")[0]!;
    const changed = await call("POST", "/api/v1/user/password", {
      cookie: carolCookie,
      body: { current: PASS, next: "carol-new-passphrase" },
    });
    expect(changed.status).toBe(200);
    expect(
      (
        await call("POST", "/api/v1/sessions", {
          body: { username: "carol", password: PASS },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("POST", "/api/v1/sessions", {
          body: { username: "carol", password: "carol-new-passphrase" },
        })
      ).status,
    ).toBe(201);
  });

  // ── tokens ───────────────────────────────────────────────────────────

  test("tokens are listed and revoked with the account, not with a token", async () => {
    expect(
      (await call("GET", "/api/v1/tokens", { token: aliceAdmin })).status,
    ).toBe(403);
    const listed = await call("GET", "/api/v1/tokens", {
      auth: basic("alice"),
    });
    expect(listed.status).toBe(200);
    const names = listed.list.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["rw", "admin", "ro"]));
    expect(listed.list.every((t) => t.token === undefined)).toBe(true);

    const throwaway = await call("POST", "/api/v1/tokens", {
      body: { adminConfirm: true, username: "alice", password: PASS, name: "tmp", scope: "ro" },
    });
    const id = throwaway.json.id as string;
    expect(
      (await call("DELETE", `/api/v1/tokens/${id}`, { token: aliceAdmin }))
        .status,
    ).toBe(403);
    // Bob cannot revoke Alice's token: it isn't his, so it doesn't exist.
    expect(
      (await call("DELETE", `/api/v1/tokens/${id}`, { auth: basic("bob") }))
        .status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/v1/tokens/${id}`, { cookie: aliceCookie }))
        .status,
    ).toBe(204);
    expect(
      (
        await call("GET", "/api/v1/user", {
          token: throwaway.json.token as string,
        })
      ).status,
    ).toBe(401);
    expect(kinds()).toContain("token.created");
    expect(kinds()).toContain("token.deleted");
  });

  // ── default branch & settings events ─────────────────────────────────

  test("the default branch moves git HEAD first, and only to a real branch", async () => {
    const bad = await call("PATCH", "/api/v1/repos/alice/pub", {
      token: aliceAdmin,
      body: { defaultBranch: "nope" },
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe("unknown_branch");
    const canary = join(work, "written-by-git");
    expect(
      (
        await call("PATCH", "/api/v1/repos/alice/pub", {
          token: aliceAdmin,
          body: { defaultBranch: `--output=${canary}` },
        })
      ).status,
    ).toBe(422);
    expect(existsSync(canary)).toBe(false);

    const moved = await call("PATCH", "/api/v1/repos/alice/pub", {
      token: aliceAdmin,
      body: { defaultBranch: "feature", description: "moved" },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.defaultBranch).toBe("feature");
    const dir = join(app.reposRoot, "alice", "pub.git");
    expect(await git(["symbolic-ref", "HEAD"], dir)).toBe("refs/heads/feature");
    const branches = await call("GET", "/api/v1/repos/alice/pub/branches");
    expect((branches.json.items as Json[]).find((b) => b.isDefault)?.name).toBe("feature");
    const back = await call("PATCH", "/api/v1/repos/alice/pub", {
      token: aliceAdmin,
      body: { defaultBranch: "main" },
    });
    expect(back.status).toBe(200);
    expect(await git(["symbolic-ref", "HEAD"], dir)).toBe("refs/heads/main");

    const settingsEvents = listEvents(app.db, { limit: 1000 }).filter(
      (e) => e.kind === "repo.settings_updated",
    );
    expect(settingsEvents.length).toBeGreaterThanOrEqual(2);
    expect(
      settingsEvents.some((e) =>
        "defaultBranch" in (e.payload.changed as object),
      ),
    ).toBe(true);
  });

  // ── labels ───────────────────────────────────────────────────────────

  test("labels: admin-managed, writer-assigned, visible to readers, filterable", async () => {
    // Creating a label is repo administration.
    expect(
      (
        await call("POST", "/api/v1/repos/alice/pub/labels", {
          token: aliceRw,
          body: { name: "bug", color: "ff0000" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("POST", "/api/v1/repos/alice/pub/labels", {
          token: bobRw,
          body: { name: "bug", color: "ff0000" },
        })
      ).status,
    ).toBe(403);
    const bug = await call("POST", "/api/v1/repos/alice/pub/labels", {
      token: aliceAdmin,
      body: { name: "bug", color: "ff0000" },
    });
    expect(bug.status).toBe(201);
    const queue = await call("POST", "/api/v1/repos/alice/pub/labels", {
      token: aliceAdmin,
      body: { name: "queue", color: "00ff00" },
    });
    expect(queue.status).toBe(201);
    expect(
      ((await call("GET", "/api/v1/repos/alice/pub/labels")).json.items as Json[]).map(
        (l) => l.name,
      ),
    ).toEqual(["bug", "queue"]);

    const one = await call("POST", "/api/v1/repos/alice/pub/issues", {
      token: bobRw,
      body: { title: "first issue" },
    });
    const two = await call("POST", "/api/v1/repos/alice/pub/issues", {
      token: aliceRw,
      body: { title: "second issue" },
    });
    expect(one.json.labels).toEqual([]);
    const n1 = one.json.number as number;
    const n2 = two.json.number as number;

    // Bob can read (and even authored #1) but is not a writer: forbidden.
    expect(
      (
        await call("PUT", `/api/v1/repos/alice/pub/issues/${n1}/labels`, {
          token: bobRw,
          body: { labels: ["bug"] },
        })
      ).status,
    ).toBe(403);
    // A read-only token fails the scope floor before anything else.
    expect(
      (
        await call("PUT", `/api/v1/repos/alice/pub/issues/${n1}/labels`, {
          token: aliceRo,
          body: { labels: ["bug"] },
        })
      ).status,
    ).toBe(403);
    // Unknown labels reject the whole set.
    const unknown = await call(
      "PUT",
      `/api/v1/repos/alice/pub/issues/${n1}/labels`,
      {
        token: aliceRw,
        body: { labels: ["bug", "ghost"] },
      },
    );
    expect(unknown.status).toBe(422);
    expect(unknown.json.error).toBe("unknown_label");
    expect(
      (await call("GET", `/api/v1/repos/alice/pub/issues/${n1}`)).json.labels,
    ).toEqual([]);

    // By name and by id, case-insensitive, de-duplicated.
    const set = await call(
      "PUT",
      `/api/v1/repos/alice/pub/issues/${n1}/labels`,
      {
        token: aliceRw,
        body: { labels: ["BUG", bug.json.id, "queue"] },
      },
    );
    expect(set.status).toBe(200);
    expect(set.list.map((l) => l.name)).toEqual(["bug", "queue"]);
    await call("PUT", `/api/v1/repos/alice/pub/issues/${n2}/labels`, {
      token: aliceRw,
      body: { labels: ["queue"] },
    });

    const bugs = await call("GET", "/api/v1/repos/alice/pub/issues?label=bug");
    expect((bugs.json.items as Json[]).map((i) => i.number)).toEqual([n1]);
    const queued = await call(
      "GET",
      "/api/v1/repos/alice/pub/issues?label=queue",
    );
    expect((queued.json.items as Json[]).map((i) => i.number)).toEqual([
      n2,
      n1,
    ]);
    expect(
      ((queued.json.items as Json[])[0]!.labels as Json[]).map((l) => l.name),
    ).toEqual(["queue"]);
    const byBob = await call(
      "GET",
      "/api/v1/repos/alice/pub/issues?author=bob",
    );
    expect((byBob.json.items as Json[]).map((i) => i.number)).toEqual([n1]);

    // Deleting a label unlinks it everywhere.
    expect(
      (
        await call(
          "DELETE",
          `/api/v1/repos/alice/pub/labels/${queue.json.id}`,
          {
            token: aliceAdmin,
          },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        (await call("GET", `/api/v1/repos/alice/pub/issues/${n2}`)).json
          .labels as Json[]
      ).length,
    ).toBe(0);
    expect(kinds()).toContain("label.created");
    expect(kinds()).toContain("label.deleted");
    expect(kinds()).toContain("issue.labeled");
  });

  // ── pulls: labels, close/reopen, reviews, cross-repo ─────────────────

  test("a pull can be labeled, closed, reopened — but never reopened once merged", async () => {
    const pr = await call("POST", "/api/v1/repos/alice/pub/pulls", {
      token: bobRw,
      body: { title: "Feature", base: "main", head: "feature" },
    });
    expect(pr.status).toBe(201);
    const n = pr.json.number as number;

    // The pull number works on the labels endpoint (one table).
    const labeled = await call(
      "PUT",
      `/api/v1/repos/alice/pub/pulls/${n}/labels`,
      {
        token: aliceRw,
        body: { labels: ["bug"] },
      },
    );
    expect(labeled.status).toBe(200);
    expect(
      (
        (await call("GET", `/api/v1/repos/alice/pub/pulls?state=all`)).json
          .items as Json[]
      ).find((p) => p.number === n)?.labels,
    ).toMatchObject([{ name: "bug" }]);
    // The issue endpoint answers the shared number, marked as a pull (#3299).
    const asIssue = await call("GET", `/api/v1/repos/alice/pub/issues/${n}`);
    expect(asIssue.status).toBe(200);
    expect(asIssue.json.kind).toBe("pull");
    expect(
      (
        await call("PATCH", `/api/v1/repos/alice/pub/issues/${n}`, {
          token: aliceRw,
          body: { state: "closed" },
        })
      ).status,
    ).toBe(404);

    // Carol (a reader, not the author) cannot close it; Bob (author) can.
    const carolRw = await mint("carol", "rw").catch(() => "");
    if (carolRw) {
      expect(
        (
          await call("PATCH", `/api/v1/repos/alice/pub/pulls/${n}`, {
            token: carolRw,
            body: { state: "closed" },
          })
        ).status,
      ).toBe(403);
    }
    const closed = await call("PATCH", `/api/v1/repos/alice/pub/pulls/${n}`, {
      token: bobRw,
      body: { state: "closed" },
    });
    expect(closed.status).toBe(200);
    expect(closed.json.state).toBe("closed");
    expect(
      (
        await call("POST", `/api/v1/repos/alice/pub/pulls/${n}/merge`, {
          token: aliceRw,
          body: {},
        })
      ).json.error,
    ).toBe("closed");
    const reopened = await call("PATCH", `/api/v1/repos/alice/pub/pulls/${n}`, {
      token: aliceRw,
      body: { state: "open" },
    });
    expect(reopened.json.state).toBe("open");
    expect(kinds()).toContain("pull.closed");
    expect(kinds()).toContain("pull.reopened");

    // Review before merging: anchors are validated against the diff and the
    // hash is the server's business.
    const bad = await call(
      "POST",
      `/api/v1/repos/alice/pub/pulls/${n}/reviews`,
      {
        token: bobRw,
        body: { path: "code.txt", side: "new", line: 99, body: "where?" },
      },
    );
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe("bad_anchor");
    expect(
      (
        await call("POST", `/api/v1/repos/alice/pub/pulls/${n}/reviews`, {
          token: bobRw,
          body: { path: "nope.txt", side: "new", line: 1, body: "where?" },
        })
      ).json.error,
    ).toBe("bad_anchor");
    const review = await call(
      "POST",
      `/api/v1/repos/alice/pub/pulls/${n}/reviews`,
      {
        token: bobRw,
        body: { path: "code.txt", side: "new", line: 2, body: "shouting?" },
      },
    );
    expect(review.status).toBe(201);
    expect(review.json.lineHash).toMatch(/^[0-9a-f]{16}$/);
    const onOld = await call(
      "POST",
      `/api/v1/repos/alice/pub/pulls/${n}/reviews`,
      {
        token: bobRw,
        body: { path: "code.txt", side: "old", line: 2, body: "was quieter" },
      },
    );
    expect(onOld.status).toBe(201);

    let reviews = await call(
      "GET",
      `/api/v1/repos/alice/pub/pulls/${n}/reviews`,
    );
    expect(reviews.list.map((r) => r.outdated)).toEqual([false, false]);

    // Rewrite line 2 on the head branch: the new-side comment goes stale, the
    // old-side one (anchored to base content) stays current.
    await call("POST", "/api/v1/repos/alice/pub/contents", {
      token: aliceRw,
      body: {
        branch: "feature",
        message: "quieter",
        files: [{ path: "code.txt", content: "alpha\nBeta\ngamma\ndelta\n" }],
      },
    });
    reviews = await call("GET", `/api/v1/repos/alice/pub/pulls/${n}/reviews`);
    expect(reviews.list.map((r) => [r.side, r.outdated])).toEqual([
      ["new", true],
      ["old", false],
    ]);

    const merged = await call(
      "POST",
      `/api/v1/repos/alice/pub/pulls/${n}/merge`,
      {
        token: aliceRw,
        body: { strategy: "squash" },
      },
    );
    expect(merged.status).toBe(200);
    const again = await call("PATCH", `/api/v1/repos/alice/pub/pulls/${n}`, {
      token: aliceRw,
      body: { state: "open" },
    });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("already_merged");
  });

  test("a fork proposes upstream through the API with headRepo", async () => {
    const fork = await call("POST", "/api/v1/repos/alice/pub/forks", {
      token: bobRw,
      body: {},
    });
    expect(fork.status).toBe(201);
    await call("POST", "/api/v1/repos/bob/pub/contents", {
      token: bobRw,
      body: {
        branch: "bobs-idea",
        message: "idea",
        files: [{ path: "idea.txt", content: "hi\n" }],
      },
    });
    // Unknown or unreadable head repos are not_found; a non-fork is refused.
    expect(
      (
        await call("POST", "/api/v1/repos/alice/pub/pulls", {
          token: bobRw,
          body: {
            title: "x",
            base: "main",
            head: "bobs-idea",
            headRepo: "bob/nope",
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/api/v1/repos/alice/pub/pulls", {
          token: bobRw,
          body: {
            title: "x",
            base: "main",
            head: "main",
            headRepo: "alice/secret",
          },
        })
      ).status,
    ).toBe(404);
    const pr = await call("POST", "/api/v1/repos/alice/pub/pulls", {
      token: bobRw,
      body: {
        title: "Bob's idea",
        base: "main",
        head: "bobs-idea",
        headRepo: "bob/pub",
      },
    });
    expect(pr.status).toBe(201);
    expect(pr.json.crossRepo).toBe(true);
    const detail = await call(
      "GET",
      `/api/v1/repos/alice/pub/pulls/${pr.json.number as number}`,
    );
    expect((detail.json.diff as Json).files).toHaveLength(1);
    const forks = await call("GET", "/api/v1/repos/alice/pub/forks");
    expect((forks.json.items as Json[]).map((f) => f.ownerName)).toEqual(["bob"]);
  });

  test("numbers from another repo are not_found here", async () => {
    const other = await call("POST", "/api/v1/repos/alice/secret/issues", {
      token: aliceRw,
      body: { title: "private matter" },
    });
    const n = other.json.number as number;
    // alice/pub has no such conversation at that number as a pull — and a
    // private repo's numbers say nothing through a public one.
    expect(
      (await call("GET", `/api/v1/repos/alice/pub/pulls/999`)).status,
    ).toBe(404);
    expect(
      (
        await call("PUT", `/api/v1/repos/bob/pub/issues/${n}/labels`, {
          token: bobRw,
          body: { labels: [] },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("GET", `/api/v1/repos/alice/secret/issues/${n}`, {
          token: bobRw,
        })
      ).status,
    ).toBe(404);
  });

  // ── orgs & teams ─────────────────────────────────────────────────────

  test("orgs and teams: what each caller may see and do", async () => {
    // Alice changed her email above; the new address is taken as proven.
    proveAll(app);
    expect(
      (
        await call("POST", "/api/v1/orgs", {
          token: aliceRw,
          body: { name: "acme" },
        })
      ).status,
    ).toBe(201);
    const devs = await call("POST", "/api/v1/orgs/acme/teams", {
      token: aliceAdmin,
      body: { name: "devs", permission: "write" },
    });
    expect(devs.status).toBe(201);
    expect(
      (
        await call("POST", "/api/v1/orgs/acme/teams/devs/members", {
          token: aliceAdmin,
          body: { user: "bob" },
        })
      ).status,
    ).toBe(201);
    await call("POST", "/api/v1/orgs/acme/teams", {
      token: aliceAdmin,
      body: { name: "ops", permission: "read" },
    });

    // Admin sees all teams; a member their own; a stranger none.
    const asAdmin = await call("GET", "/api/v1/orgs/acme", { token: aliceRo });
    expect((asAdmin.json.teams as Json[]).map((t) => t.name).sort()).toEqual([
      "Owners",
      "devs",
      "ops",
    ]);
    const asBob = await call("GET", "/api/v1/orgs/acme/teams", {
      token: bobRw,
    });
    expect((asBob.json.items as Json[]).map((t) => t.name)).toEqual(["devs"]);
    expect(asBob.json.next_cursor).toBeNull();
    expect((await call("GET", "/api/v1/orgs/acme/teams")).json).toEqual({
      items: [],
      next_cursor: null,
    });
    expect((await call("GET", "/api/v1/orgs/alice")).status).toBe(404);

    // Members are visible to those who can see the team.
    const members = await call("GET", "/api/v1/orgs/acme/teams/devs/members", {
      token: bobRw,
    });
    expect((members.json.items as Json[]).map((m) => m.username)).toEqual(["bob"]);
    expect(
      (
        await call("GET", "/api/v1/orgs/acme/teams/ops/members", {
          token: bobRw,
        })
      ).status,
    ).toBe(404);

    // Bob is a writer, not an admin: team management is hidden from him.
    expect(
      (
        await call("DELETE", "/api/v1/orgs/acme/teams/ops", {
          token: await mint("bob", "admin"),
        })
      ).status,
    ).toBe(404);
    // Owners can't be deleted nor emptied.
    const protectedTeam = await call(
      "DELETE",
      "/api/v1/orgs/acme/teams/Owners",
      {
        token: aliceAdmin,
      },
    );
    expect(protectedTeam.status).toBe(409);
    expect(protectedTeam.json.error).toBe("protected");
    const lastOwner = await call(
      "DELETE",
      "/api/v1/orgs/acme/teams/Owners/members/alice",
      { token: aliceAdmin },
    );
    expect(lastOwner.status).toBe(409);
    expect(
      (
        await call("DELETE", "/api/v1/orgs/acme/teams/devs/members/carol", {
          token: aliceAdmin,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("DELETE", "/api/v1/orgs/acme/teams/devs/members/bob", {
          token: aliceAdmin,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call("DELETE", "/api/v1/orgs/acme/teams/ops", {
          token: aliceAdmin,
        })
      ).status,
    ).toBe(204);

    const myOrgs = await call("GET", "/api/v1/user/orgs", { token: aliceRo });
    const orgItems = (r: { json: Json }) => (r.json.items ?? []) as Json[];
    expect(orgItems(myOrgs).map((o) => o.username)).toEqual(["acme"]);
    expect(myOrgs.json.next_cursor).toBeNull();
    expect(
      orgItems(await call("GET", "/api/v1/user/orgs", { token: bobRw })),
    ).toEqual([]);
    for (const kind of [
      "team.created",
      "team.deleted",
      "team.member_added",
      "team.member_removed",
    ])
      expect(kinds()).toContain(kind);
  });

  test("teams and members page as { items, next_cursor }", async () => {
    await call("POST", "/api/v1/orgs/acme/teams", {
      token: aliceAdmin,
      body: { name: "zeta", permission: "read" },
    });
    const all = await call("GET", "/api/v1/orgs/acme/teams", { token: aliceAdmin });
    const names = (all.json.items as Json[]).map((t) => t.name as string);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(all.json.next_cursor).toBeNull();
    const first = await call("GET", "/api/v1/orgs/acme/teams?limit=2", { token: aliceAdmin });
    expect((first.json.items as Json[]).map((t) => t.name)).toEqual(names.slice(0, 2));
    expect(first.json.next_cursor).toBe(names[1]!);
    const second = await call(
      "GET",
      `/api/v1/orgs/acme/teams?limit=200&cursor=${names[1]}`,
      { token: aliceAdmin },
    );
    expect((second.json.items as Json[]).map((t) => t.name)).toEqual(names.slice(2));
    expect(second.json.next_cursor).toBeNull();

    for (const user of ["bob", "carol"])
      await call("POST", "/api/v1/orgs/acme/teams/devs/members", {
        token: aliceAdmin,
        body: { user },
      });
    const m1 = await call("GET", "/api/v1/orgs/acme/teams/devs/members?limit=1", {
      token: aliceAdmin,
    });
    expect((m1.json.items as Json[]).map((m) => m.username)).toEqual(["bob"]);
    expect(m1.json.next_cursor).toBe("bob");
    const m2 = await call("GET", "/api/v1/orgs/acme/teams/devs/members?limit=1&cursor=bob", {
      token: aliceAdmin,
    });
    expect((m2.json.items as Json[]).map((m) => m.username)).toEqual(["carol"]);
    expect(m2.json.next_cursor).toBeNull();

    // A member of a private team is not shown to an outsider.
    const outsider = await call("GET", "/api/v1/orgs/acme/teams/zeta/members", { token: bobRw });
    expect(outsider.status).toBe(404);
    expect(outsider.json.items).toBeUndefined();

    for (const path of ["teams", "teams/devs/members"])
      for (const bad of ["0", "201", "-1", "abc", "1.5"]) {
        const res = await call("GET", `/api/v1/orgs/acme/${path}?limit=${bad}`, {
          token: aliceAdmin,
        });
        expect(res.status).toBe(422);
        expect(res.json.error).toBe("invalid_limit");
      }

    // The cursor is only compared: any 1..160 characters, nothing else.
    for (const path of ["teams", "teams/devs/members"])
      for (const bad of ["", "x".repeat(161)]) {
        const res = await call("GET", `/api/v1/orgs/acme/${path}?cursor=${bad}`, {
          token: aliceAdmin,
        });
        expect(res.status).toBe(422);
        expect(res.json.error).toBe("invalid_cursor");
      }

    // A name with a control character pages on: its own cursor is accepted.
    const odd = await call("POST", "/api/v1/orgs/acme/teams", {
      token: aliceAdmin,
      body: { name: "a\u0001b", permission: "read" },
    });
    expect(odd.status).toBe(201);
    {
      const list = await call("GET", "/api/v1/orgs/acme/teams", { token: aliceAdmin });
      const at = (list.json.items as Json[]).findIndex((t) => t.name === "a\u0001b");
      const page = await call("GET", `/api/v1/orgs/acme/teams?limit=${at + 1}`, {
        token: aliceAdmin,
      });
      expect(page.json.next_cursor).toBe("a\u0001b");
      const next = await call(
        "GET",
        `/api/v1/orgs/acme/teams?cursor=${encodeURIComponent("a\u0001b")}`,
        { token: aliceAdmin },
      );
      expect(next.status).toBe(200);
    }

    // The default page is 50.
    for (let i = 0; i < 50; i++)
      await call("POST", "/api/v1/orgs/acme/teams", {
        token: aliceAdmin,
        body: { name: `p${String(i).padStart(2, "0")}`, permission: "read" },
      });
    const dflt = await call("GET", "/api/v1/orgs/acme/teams", { token: aliceAdmin });
    expect((dflt.json.items as Json[]).length).toBe(50);
    expect(dflt.json.next_cursor).not.toBeNull();
  });

  test("a team member sees the org's private repos in listings", async () => {
    await call("POST", "/api/v1/repos", {
      token: aliceRw,
      body: { owner: "acme", name: "internal", visibility: "private" },
    });
    await call("POST", "/api/v1/orgs/acme/teams/devs/members", {
      token: aliceAdmin,
      body: { user: "bob" },
    });
    const bobSees = await call("GET", "/api/v1/repos", { token: bobRw });
    const names = (bobSees.json.items as Json[]).map(
      (r) => `${r.ownerName}/${r.name}`,
    );
    expect(names).toContain("acme/internal");
    expect(names).not.toContain("alice/secret");
    const carolSees = await call("GET", "/api/v1/users/acme/repos");
    expect((carolSees.json.items as Json[]).length).toBe(0);
  });

  // ── webhooks events ──────────────────────────────────────────────────

  test("webhook lifecycle is recorded without its secret", async () => {
    const hook = await call("POST", "/api/v1/repos/alice/pub/hooks", {
      token: aliceAdmin,
      body: { url: "https://example.com/hook", secret: "hunter2-secret" },
    });
    expect(hook.status).toBe(201);
    await call(
      "DELETE",
      `/api/v1/repos/alice/pub/hooks/${hook.json.id as string}`,
      {
        token: aliceAdmin,
      },
    );
    const events = listEvents(app.db, { limit: 1000 }).filter((e) =>
      e.kind.startsWith("webhook."),
    );
    expect(events.map((e) => e.kind).sort()).toEqual([
      "webhook.created",
      "webhook.deleted",
    ]);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(
      "hunter2",
    );
  });

  // ── read parity ──────────────────────────────────────────────────────

  test("tags, single commits with their diff, and paginated lists", async () => {
    const remote = `${base.replace("http://", `http://alice:${aliceRw}@`)}/alice/pub.git`;
    await git(["clone", remote, "pub"], work);
    const dir = join(work, "pub");
    await git(["tag", "-a", "v1", "-m", "release one"], dir);
    await git(["tag", "light"], dir);
    await git(["push", "origin", "--tags"], dir);
    const tags = await call("GET", "/api/v1/repos/alice/pub/tags");
    const items = tags.json.items as Json[];
    expect(items.map((t) => t.name).sort()).toEqual(["light", "v1"]);
    expect(tags.json.next_cursor).toBeNull();
    const head = await git(["rev-parse", "HEAD"], dir);
    for (const t of items) expect(t.commit).toBe(head);
    expect(items.find((t) => t.name === "v1")?.oid).not.toBe(head);

    const first = await call("GET", "/api/v1/repos/alice/pub/tags?limit=1");
    expect((first.json.items as Json[]).length).toBe(1);
    const tagCursor = first.json.next_cursor as string;
    expect(tagCursor).toBe(String((first.json.items as Json[])[0]!.name));
    const rest = await call(
      "GET",
      `/api/v1/repos/alice/pub/tags?limit=1&cursor=${encodeURIComponent(tagCursor)}`,
    );
    expect((rest.json.items as Json[]).map((t) => t.name)).not.toContain(tagCursor);
    expect(rest.json.next_cursor).toBeNull();
    // Newest first by date, not by name: the older tag has the later name.
    await git(["tag", "-a", "zzz-old", "-m", "old"], dir, { GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" });
    await git(["tag", "-a", "aaa-new", "-m", "new"], dir, { GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z" });
    await git(["push", "origin", "--tags"], dir);
    const dated = await call("GET", "/api/v1/repos/alice/pub/tags");
    const order = (dated.json.items as Json[]).map((t) => t.name);
    expect(order.slice(-2)).toEqual(["aaa-new", "zzz-old"]);
    // A cursor whose tag is gone is refused, not read as the first page.
    const gone = await call("GET", "/api/v1/repos/alice/pub/tags?cursor=no-such-tag");
    expect(gone.status).toBe(422);
    expect(gone.json.error).toBe("invalid_cursor");
    expect((await call("GET", "/api/v1/repos/alice/pub/tags?limit=0")).status).toBe(422);
    expect((await call("GET", "/api/v1/repos/alice/pub/tags?limit=999")).status).toBe(422);
    expect((await call("GET", "/api/v1/repos/alice/pub/tags?cursor=a..b")).status).toBe(422);

    const commits = await call("GET", "/api/v1/repos/alice/pub/commits");
    const oid = commits.list[0]!.oid as string;
    const one = await call("GET", `/api/v1/repos/alice/pub/commits/${oid}`);
    expect(one.status).toBe(200);
    expect(one.json.oid).toBe(oid);
    expect(((one.json.diff as Json).files as Json[]).length).toBeGreaterThan(0);
    expect(
      (await call("GET", "/api/v1/repos/alice/pub/commits/main")).status,
    ).toBe(200);
    expect(
      (await call("GET", "/api/v1/repos/alice/pub/commits/deadbeef")).status,
    ).toBe(404);
    expect(
      (await call("GET", "/api/v1/repos/alice/pub/commits/--help")).status,
    ).toBe(404);

    // Pagination: three more issues, then walk them two at a time.
    for (const title of ["p1", "p2", "p3"])
      await call("POST", "/api/v1/repos/alice/pub/issues", {
        token: aliceRw,
        body: { title },
      });
    const all = await call("GET", "/api/v1/repos/alice/pub/issues?state=all");
    const total = (all.json.items as Json[]).length;
    expect(all.json.next_cursor).toBeNull();
    const seen: number[] = [];
    let cursor: string | number | null = null;
    do {
      const page = await call(
        "GET",
        `/api/v1/repos/alice/pub/issues?state=all&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      const items = page.json.items as Json[];
      expect(items.length).toBeLessThanOrEqual(2);
      seen.push(...items.map((i) => i.number as number));
      cursor = page.json.next_cursor as number | null;
    } while (cursor !== null);
    expect(seen).toHaveLength(total);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    expect(new Set(seen).size).toBe(total);
    // Limits are validated, never trusted: past the ceiling is a 422.
    expect(
      (await call("GET", "/api/v1/repos/alice/pub/issues?state=all&limit=99999")).status,
    ).toBe(422);
    expect(
      (
        (await call("GET", "/api/v1/repos/alice/pub/issues?state=all&limit=200"))
          .json.items as Json[]
      ).length,
    ).toBe(total);

    const repos = await call("GET", "/api/v1/repos?limit=1", {
      token: aliceRw,
    });
    expect((repos.json.items as Json[]).length).toBe(1);
    expect(typeof repos.json.next_cursor).toBe("string");
    const next = await call(
      "GET",
      `/api/v1/repos?limit=50&cursor=${repos.json.next_cursor as string}`,
      { token: aliceRw },
    );
    expect(
      (next.json.items as Json[]).some(
        (r) => r.id === (repos.json.items as Json[])[0]!.id,
      ),
    ).toBe(false);
  });

  // ── sessions ─────────────────────────────────────────────────────────

  test("expired sessions are pruned", () => {
    const alice = getRepo(app.db, "alice", "pub")!.ownerId;
    createSession(app.db, alice);
    app.db
      .query(
        "INSERT INTO session (token_hash, user_id, expires_at) VALUES ('stale', ?1, '2000-01-01T00:00:00.000Z')",
      )
      .run(alice);
    const before = app.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session")
      .get()!.n;
    expect(pruneSessions(app.db)).toBe(1);
    expect(
      app.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session")
        .get()!.n,
    ).toBe(before - 1);
  });
});
