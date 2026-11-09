import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listEvents } from "../src/core/events.ts";
import { firstFetchRetry } from "../src/origins/mirror.ts";
import { forkBackoff } from "../src/origins/fork-route.ts";
import { settled } from "../src/origins/jobs.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeState,
} from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

/**
 * The fork flow: grab a repository you cannot push to, branch, edit, and
 * propose it back.
 *
 * Two real forges and a fake API in front of one of them, because every
 * interesting part of this is an interaction: the fork that does not exist
 * yet when the origin says it made one, the branch that has to start from
 * the *upstream's* base rather than the fork's stale copy of it, the push
 * that must land on the fork's git before anything moves locally, and the
 * `owner:branch` head form that is the only way to say "this branch, in that
 * repository". A stub of the provider would prove none of them.
 *
 * The second forge is a real `forge` — it is the git host the fake's clone
 * URLs point at, so pushes really are pushes and a branch that "landed" can
 * be read back over its own API.
 */

const ORIGIN_LOGIN = "me";
const UPSTREAM_OWNER = "octo";
const PASSWORD = "fork-flow-account-pass";

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("the fork flow", () => {
  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let base: string;
  /** A `forge_` token for `me` on the upstream forge — the credential the
   * fake accepts AND the one git authenticates the push-through with. */
  let originToken = "";
  let aliceToken = "";
  let bobToken = "";

  let forgejo: FakeForge;
  let github: FakeForge;
  let forgejoOrigin = "";
  let githubOrigin = "";
  /** The local mirror of `octo/gears`, once one exists. */
  let mirrorPath = "";
  let mirroredPull = 0;

  /** An authenticated JSON call at the local forge. */
  const api = (
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${init.token ?? aliceToken}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };

  /** A call at the upstream forge, as one of its own accounts. */
  const upstream = (
    path: string,
    init: RequestInit & { as?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic(init.as ?? UPSTREAM_OWNER, PASSWORD));
    return fetch(`${originServers.url}${path}`, { ...init, headers });
  };

  async function mkAccount(server: Servers, username: string): Promise<string> {
    await fetch(`${server.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@f.dev`,
        password: PASSWORD,
      }),
    });
    return tokenFor(server === originServers ? originApp : app, username, "admin");
  }

  /** Seed a public repo on the upstream forge with one file on `main`. */
  async function seedUpstream(name: string, owner = UPSTREAM_OWNER) {
    await upstream("/api/v1/repos", {
      as: owner,
      method: "POST",
      body: JSON.stringify({ name, visibility: "public" }),
    });
    await upstream(`/api/v1/repos/${owner}/${name}/contents`, {
      as: owner,
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "a.txt", content: "one\n" }],
      }),
    });
  }

  // The origin does not finish making a fork before it answers: a read of
  // the new repository 404s before it appears. This is GitHub's real
  // behaviour, and the reason `forkOrigin` polls at all. One 404 makes the
  // poll go round; the backoff between polls is shortened to 10 ms, since
  // what is proved is that it goes round, not how long it waits.
  const fakeFor = (
    kind: "forgejo" | "github",
    repos: FakeState["repos"],
    forkDelayReads = 1,
  ) => {
    const state = newFakeState(kind, ORIGIN_LOGIN, originToken);
    state.repos.push(...repos);
    state.forkDelayReads = forkDelayReads;
    return serveFakeForge(state);
  };

  const connect = async (fake: FakeForge, kind?: "github"): Promise<string> => {
    const connected = await api("/api/v1/user/origins", {
      method: "POST",
      body: JSON.stringify({
        host: fake.url,
        token: originToken,
        ...(kind === undefined ? {} : { kind }),
      }),
    });
    expect(connected.status).toBe(201);
    return (await read<{ id: string }>(connected)).id;
  };

  const foundBackoff = forkBackoff.ms;

  beforeAll(async () => {
    forkBackoff.ms = [10];
    dataDir = await mkdtemp(join(tmpdir(), "forge-ff-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-ff-up-"));

    // Both forges are built at once: nothing on one waits for the other
    // until the origins are connected.
    // ---- the upstream forge: the git host behind every fake clone URL ----
    originApp = createApp({ dataDir: originDataDir, port: 0 });
    // ---- the local forge ----
    app = createApp({ dataDir, port: 0 });
    [originServers, servers] = await Promise.all([serve(originApp), serve(app)]);
    base = servers.url;
    [, originToken, aliceToken, bobToken] = await Promise.all([
      mkAccount(originServers, UPSTREAM_OWNER),
      mkAccount(originServers, ORIGIN_LOGIN),
      mkAccount(servers, "alice"),
      mkAccount(servers, "bob"),
    ]);
    proveAll(originApp);
    promote(originApp.db);
    proveAll(app);
    promote(app.db);

    await Promise.all([
      seedUpstream("gears"),
      seedUpstream("widgets"),
      // A repo `me` owns outright — the "you can already push here" case.
      seedUpstream("own", ORIGIN_LOGIN),
    ]);

    // `me` really forks both upstreams, so the fake's clone URL for the fork
    // points at a repository that exists and that `me` may push to.
    const forks = await Promise.all(
      ["gears", "widgets"].map((name) =>
        upstream(`/api/v1/repos/${UPSTREAM_OWNER}/${name}/forks`, {
          as: ORIGIN_LOGIN,
          method: "POST",
          body: "{}",
        }),
      ),
    );
    for (const forked of forks) expect(forked.status).toBe(201);

    // The upstream forge stands in for the origin's git, not for its push
    // policy: GitHub runs no forge hooks. Each contribution pushes twice into
    // these three repositories, and each push would spawn two Bun processes
    // to ask the upstream forge's own rules, about 100 ms a push. A hook
    // that accepts keeps the pushes real and leaves the local forge's own
    // hooks, which this file does exercise, as they are.
    await Promise.all(
      ["gears", "widgets", "own"].flatMap((name) =>
        ["pre-receive", "post-receive"].map((hook) =>
          writeFile(
            join(originDataDir, "repos", ORIGIN_LOGIN, `${name}.git`, "hooks", hook),
            "#!/bin/sh\nexit 0\n",
          ),
        ),
      ),
    );

    // The upstream moves on AFTER the fork: a branch started from the fork's
    // own copy of main would now be proposing a stale tree.
    await upstream(`/api/v1/repos/${UPSTREAM_OWNER}/gears/contents`, {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "upstream moved",
        files: [{ path: "moved.txt", content: "since the fork\n" }],
      }),
    });

    const git = (name: string, owner = UPSTREAM_OWNER) =>
      `${originServers.url}/${owner}/${name}.git`;

    forgejo = fakeFor("forgejo", [
      {
        id: 1,
        fullName: `${UPSTREAM_OWNER}/gears`,
        cloneUrl: git("gears"),
        defaultBranch: "main",
        // The whole premise: this account cannot push here.
        push: false,
        admin: false,
      },
      {
        id: 2,
        fullName: `${ORIGIN_LOGIN}/own`,
        cloneUrl: git("own", ORIGIN_LOGIN),
        defaultBranch: "main",
        push: true,
        admin: true,
      },
    ]);
    github = fakeFor("github", [
      {
        id: 11,
        fullName: `${UPSTREAM_OWNER}/widgets`,
        cloneUrl: git("widgets"),
        defaultBranch: "main",
        push: false,
        admin: false,
      },
    ]);

    [forgejoOrigin, githubOrigin] = await Promise.all([
      connect(forgejo),
      connect(github, "github"),
    ]);
  });

  afterAll(async () => {
    forkBackoff.ms = foundBackoff;
    forgejo.stop();
    github.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  // ---- forking at the origin ----

  test("a fork that does not exist yet is waited for, then mirrored", async () => {
    const response = await api(`/api/v1/user/origins/${githubOrigin}/fork`, {
      method: "POST",
      body: JSON.stringify({ fullName: `${UPSTREAM_OWNER}/widgets` }),
    });
    // 202: the repository does not exist yet, here or there.
    expect(response.status).toBe(202);
    const forked = await read<{
      remote: { fullName: string; parent: string | null };
      existed: boolean;
      job: { id: string } | null;
    }>(response);
    expect(forked.remote.fullName).toBe(`${ORIGIN_LOGIN}/widgets`);
    expect(forked.remote.parent).toBe(`${UPSTREAM_OWNER}/widgets`);
    expect(forked.existed).toBe(false);
    expect(forked.job).not.toBeNull();

    // The origin was actually asked, and asked more than once for the repo
    // it had not finished making.
    const posts = github.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/widgets/forks"),
    );
    expect(posts).toHaveLength(1);
    const polls = github.state.requests.filter(
      (r) => r.method === "GET" && r.path.endsWith(`/${ORIGIN_LOGIN}/widgets`),
    );
    expect(polls.length).toBeGreaterThan(2);

    const job = await settled(forked.job!.id);
    expect(job?.stage).toBe("done");
    expect(job?.repo).toBeDefined();

    const kinds = listEvents(app.db, { limit: 50 }).map((e) => e.kind);
    expect(kinds).toContain("repo.forked");
  });

  test("forking again returns the fork already there", async () => {
    const before = github.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/widgets/forks"),
    ).length;
    const again = await read<{
      existed: boolean;
      remote: { fullName: string };
    }>(
      await api(`/api/v1/user/origins/${githubOrigin}/fork`, {
        method: "POST",
        body: JSON.stringify({ fullName: `${UPSTREAM_OWNER}/widgets` }),
      }),
    );
    expect(again.existed).toBe(true);
    expect(again.remote.fullName).toBe(`${ORIGIN_LOGIN}/widgets`);
    const after = github.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/widgets/forks"),
    ).length;
    // Idempotent: no second fork was asked for.
    expect(after).toBe(before);
  });

  test("another account's origin does not exist for you", async () => {
    const refused = await api(`/api/v1/user/origins/${githubOrigin}/fork`, {
      method: "POST",
      token: bobToken,
      body: JSON.stringify({ fullName: `${UPSTREAM_OWNER}/widgets` }),
    });
    expect(refused.status).toBe(404);
    expect((await read<{ error: string }>(refused)).error).toBe("not_found");
  });

  // ---- contributing through a fork ----

  test("contribute forks, branches from the live upstream, and proposes back", async () => {
    const response = await api(
      `/api/v1/user/origins/${forgejoOrigin}/browse/${UPSTREAM_OWNER}/gears/contribute`,
      {
        method: "POST",
        body: JSON.stringify({
          branch: "fix-typo",
          message: "fix the typo",
          files: [{ path: "a.txt", content: "one, fixed\n" }],
          openPull: { title: "fix the typo", body: "a small thing" },
        }),
      },
    );
    expect(response.status).toBe(201);
    const result = await read<{
      via: string;
      repo: { owner: string; name: string };
      forkFullName: string | null;
      branch: string;
      commit: { commitOid: string };
      pull: { number: number; htmlUrl: string; local: unknown } | null;
    }>(response);

    expect(result.via).toBe("fork");
    expect(result.forkFullName).toBe(`${ORIGIN_LOGIN}/gears`);
    expect(result.branch).toBe("fix-typo");
    expect(result.pull).not.toBeNull();
    // We hold no mirror of the upstream, so there is no local row for the
    // pull — only the origin's number and its page.
    expect(result.pull?.local).toBeNull();

    // The branch really landed on the fork's git, at the commit we made.
    const branches = await (await read<{ items: { name: string; oid: string }[] }>(await fetch(`${originServers.url}/api/v1/repos/${ORIGIN_LOGIN}/gears/branches`))).items;
    const landed = branches.find((b) => b.name === "fix-typo");
    expect(landed?.oid).toBe(result.commit.commitOid);

    // …and it started from the CURRENT upstream main, not from the fork's
    // copy of it: the file the upstream added after the fork is in the tree.
    const moved = await fetch(
      `${originServers.url}/api/v1/repos/${ORIGIN_LOGIN}/gears/contents/moved.txt?ref=fix-typo`,
    );
    expect(moved.status).toBe(200);

    // The pull was opened UPSTREAM, with the cross-repository head form.
    const opened = forgejo.state.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.endsWith(`/${UPSTREAM_OWNER}/gears/pulls`),
    );
    expect(opened).toHaveLength(1);
    const sent = JSON.parse(opened[0]!.body) as Record<string, unknown>;
    expect(sent.head).toBe(`${ORIGIN_LOGIN}:fix-typo`);
    expect(sent.base).toBe("main");
    expect(sent.title).toBe("fix the typo");

    // And the fake stored it as a cross-repo pull, which is what a forge
    // that accepted `owner:branch` would have done.
    const stored = forgejo.state.issues.get(`${UPSTREAM_OWNER}/gears`) ?? [];
    const pull = stored.find((i) => i.number === result.pull?.number);
    expect(pull?.pull?.head).toBe("fix-typo");
    expect(pull?.pull?.headRepo).toBe(`${ORIGIN_LOGIN}/gears`);
  });

  test("push rights mean no fork: the branch lands on the upstream itself", async () => {
    const before = forgejo.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/forks"),
    ).length;

    const response = await api(
      `/api/v1/user/origins/${forgejoOrigin}/browse/${ORIGIN_LOGIN}/own/contribute`,
      {
        method: "POST",
        body: JSON.stringify({
          branch: "direct",
          message: "straight in",
          files: [{ path: "c.txt", content: "three\n" }],
          openPull: { title: "straight in" },
        }),
      },
    );
    expect(response.status).toBe(201);
    const result = await read<{
      via: string;
      forkFullName: string | null;
      branch: string;
      commit: { commitOid: string };
      pull: { number: number; local: unknown } | null;
    }>(response);
    expect(result.via).toBe("direct");
    expect(result.forkFullName).toBeNull();

    // Nothing was forked, anywhere.
    const after = forgejo.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/forks"),
    ).length;
    expect(after).toBe(before);

    // The branch is on the upstream's own git.
    const branches = await (await read<{ items: { name: string; oid: string }[] }>(await fetch(`${originServers.url}/api/v1/repos/${ORIGIN_LOGIN}/own/branches`))).items;
    expect(branches.find((b) => b.name === "direct")?.oid).toBe(
      result.commit.commitOid,
    );

    // The head is a bare branch name: no `owner:` prefix is needed, and
    // sending one would be wrong.
    const opened = forgejo.state.requests.filter(
      (r) =>
        r.method === "POST" && r.path.endsWith(`/${ORIGIN_LOGIN}/own/pulls`),
    );
    expect(opened).toHaveLength(1);
    expect((JSON.parse(opened[0]!.body) as Record<string, unknown>).head).toBe(
      "direct",
    );

    // We mirrored the upstream to work in it, so the pull was imported too.
    expect(result.pull?.local).not.toBeNull();
  });

  test("GitHub takes the same owner:branch head form", async () => {
    const response = await api(
      `/api/v1/user/origins/${githubOrigin}/browse/${UPSTREAM_OWNER}/widgets/contribute`,
      {
        method: "POST",
        body: JSON.stringify({
          branch: "gh-fix",
          message: "fix it",
          files: [{ path: "a.txt", content: "one, fixed\n" }],
          openPull: { title: "fix it" },
        }),
      },
    );
    expect(response.status).toBe(201);
    const result = await read<{
      via: string;
      commit: { commitOid: string };
      pull: { number: number } | null;
    }>(response);
    expect(result.via).toBe("fork");

    const branches = await (await read<{ items: { name: string; oid: string }[] }>(await fetch(`${originServers.url}/api/v1/repos/${ORIGIN_LOGIN}/widgets/branches`))).items;
    expect(branches.find((b) => b.name === "gh-fix")?.oid).toBe(
      result.commit.commitOid,
    );

    const opened = github.state.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.endsWith(`/${UPSTREAM_OWNER}/widgets/pulls`),
    );
    expect(opened).toHaveLength(1);
    expect((JSON.parse(opened[0]!.body) as Record<string, unknown>).head).toBe(
      `${ORIGIN_LOGIN}:gh-fix`,
    );
  });

  // ---- contributing from a mirrored upstream ----

  test("the repo route contributes to the upstream a mirror names, through the fork already made", async () => {
    // Mirror the upstream itself, then contribute from its own page.
    const job = await mirrorAndWait(
      await api(`/api/v1/user/origins/${forgejoOrigin}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: `${UPSTREAM_OWNER}/gears` }),
      }),
    );
    expect(job?.stage).toBe("done");
    const mirror = job!.repo!;
    mirrorPath = `${mirror.ownerName}/${mirror.name}`;
    const forksAsked = () =>
      forgejo.state.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/gears/forks"),
      ).length;
    const before = forksAsked();

    const response = await api(
      `/api/v1/repos/${mirror.ownerName}/${mirror.name}/contribute`,
      {
        method: "POST",
        body: JSON.stringify({
          branch: "from-the-mirror",
          message: "from the mirror",
          files: [{ path: "d.txt", content: "four\n" }],
          openPull: { title: "from the mirror" },
        }),
      },
    );
    expect(response.status).toBe(201);
    const result = await read<{
      via: string;
      forkFullName: string | null;
      pull: { number: number; local: { number: number } | null } | null;
    }>(response);
    expect(result.via).toBe("fork");
    expect(result.forkFullName).toBe(`${ORIGIN_LOGIN}/gears`);
    // A second contribution to gears reuses the fork the first one made
    // rather than asking the origin for another.
    expect(forksAsked()).toBe(before);
    // The upstream IS mirrored here, so the pull came back as a local row.
    expect(result.pull?.local?.number).toBe(result.pull!.number);

    const listed = await read<{ items: { number: number }[] }>(
      await api(`/api/v1/repos/${mirror.ownerName}/${mirror.name}/pulls`),
    );
    expect(listed.items.map((p) => p.number)).toContain(result.pull!.number);
    mirroredPull = result.pull!.number;
  });

  // ---- review states across an origin ----

  test("a verdict on a mirrored pull is passed at the origin, in its words", async () => {
    const submitted = await api(
      `/api/v1/repos/${mirrorPath}/pulls/${mirroredPull}/review-states`,
      {
        method: "POST",
        body: JSON.stringify({ state: "approved", body: "looks right" }),
      },
    );
    expect(submitted.status).toBe(201);
    const review = await read<{ state: string; originAuthor: string | null }>(
      submitted,
    );
    expect(review.state).toBe("approved");
    // Attributed to the account on the origin, not to the local mirror owner.
    expect(review.originAuthor).toBe(ORIGIN_LOGIN);

    // Forgejo's own vocabulary is APPROVED, not GitHub's APPROVE.
    const posted = forgejo.state.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.endsWith(
          `/${UPSTREAM_OWNER}/gears/pulls/${mirroredPull}/reviews`,
        ),
    );
    expect(posted).toHaveLength(1);
    expect((JSON.parse(posted[0]!.body) as Record<string, unknown>).event).toBe(
      "APPROVED",
    );

    // And it is one row here, keyed on the origin's id — not a local verdict
    // beside the remote one.
    const listed = await read<{ state: string }[]>(
      await api(
        `/api/v1/repos/${mirrorPath}/pulls/${mirroredPull}/review-states`,
      ),
    );
    expect(listed).toHaveLength(1);
  });

  test("verdicts made upstream arrive on a sync, once", async () => {
    forgejo.state.reviewStates.set(`${UPSTREAM_OWNER}/gears`, [
      ...(forgejo.state.reviewStates.get(`${UPSTREAM_OWNER}/gears`) ?? []),
      {
        id: 9001,
        issueNumber: mirroredPull,
        user: "mona",
        state: "REQUEST_CHANGES",
        body: "not like that",
        commitId: "d".repeat(40),
        submittedAt: new Date().toISOString(),
      },
      // Not a verdict: a draft nobody has submitted. Counting it would let a
      // half-written review block or unblock a merge.
      {
        id: 9002,
        issueNumber: mirroredPull,
        user: "mona",
        state: "PENDING",
        body: "",
      },
    ]);
    // The pull has to look changed for the sync to walk its thread at all.
    const stored = forgejo.state.issues.get(`${UPSTREAM_OWNER}/gears`) ?? [];
    const pull = stored.find((i) => i.number === mirroredPull);
    if (pull) pull.updatedAt = new Date().toISOString();

    for (let pass = 0; pass < 2; pass++) {
      expect(
        (await api(`/api/v1/repos/${mirrorPath}/sync`, { method: "POST" }))
          .status,
      ).toBe(200);
    }

    const listed = await read<{ state: string; originAuthor: string | null }[]>(
      await api(
        `/api/v1/repos/${mirrorPath}/pulls/${mirroredPull}/review-states`,
      ),
    );
    // The imported verdict is there exactly once, attributed to its own
    // reviewer, and the PENDING draft is not there at all.
    const monas = listed.filter((r) => r.originAuthor === "mona");
    expect(monas).toHaveLength(1);
    expect(monas[0]!.state).toBe("changes_requested");
    // Two distinct reviewers, kept distinct: every imported row is attributed
    // locally to the connecting user, so collapsing on the local author id
    // would turn two people's verdicts into whichever landed last.
    expect(new Set(listed.map((r) => r.originAuthor))).toEqual(
      new Set([ORIGIN_LOGIN, "mona"]),
    );
  });

  test("GitHub is asked for a review in its own verb vocabulary", async () => {
    const job = await mirrorAndWait(
      await api(`/api/v1/user/origins/${githubOrigin}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: `${UPSTREAM_OWNER}/widgets` }),
      }),
    );
    expect(job?.stage).toBe("done");
    const mirror = job!.repo!;
    const pulls = await read<{ items: { number: number }[] }>(
      await api(`/api/v1/repos/${mirror.ownerName}/${mirror.name}/pulls`),
    );
    expect(pulls.items.length).toBeGreaterThan(0);
    const number = pulls.items[0]!.number;

    const submitted = await api(
      `/api/v1/repos/${mirror.ownerName}/${mirror.name}/pulls/${number}/review-states`,
      {
        method: "POST",
        body: JSON.stringify({ state: "changes_requested", body: "no" }),
      },
    );
    expect(submitted.status).toBe(201);
    expect((await read<{ state: string }>(submitted)).state).toBe(
      "changes_requested",
    );

    const posted = github.state.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.endsWith(`/${UPSTREAM_OWNER}/widgets/pulls/${number}/reviews`),
    );
    expect(posted).toHaveLength(1);
    expect((JSON.parse(posted[0]!.body) as Record<string, unknown>).event).toBe(
      "REQUEST_CHANGES",
    );
  });

  test("a mirrored pull is still merged at the origin, never here", async () => {
    const refused = await api(
      `/api/v1/repos/${mirrorPath}/pulls/${mirroredPull}/merge`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(refused.status).toBe(409);
    expect((await read<{ error: string }>(refused)).error).toBe("mirrored");
  });

  test("a native fork of a mirror proposes upstream through it", async () => {
    // Alice's mirror of me/own — a repository `me` can push to — is the
    // workbench. Bob forks it here, natively: git is truth in his copy and
    // nothing he does there reaches the origin.
    const repos = await read<{
      items: {
        ownerName: string;
        name: string;
        origin: { fullName: string } | null;
      }[];
    }>(await api("/api/v1/users/alice/repos"));
    const mirror = repos.items.find(
      (r) => r.origin?.fullName === `${ORIGIN_LOGIN}/own`,
    )!;
    expect(mirror).toBeDefined();
    const forked = await api(
      `/api/v1/repos/${mirror.ownerName}/${mirror.name}/forks`,
      { method: "POST", body: "{}", token: bobToken },
    );
    expect(forked.status).toBe(201);
    const fork = await read<{
      ownerName: string;
      name: string;
      origin: unknown;
    }>(forked);
    expect(fork.origin).toBeNull();
    const committed = await api(
      `/api/v1/repos/${fork.ownerName}/${fork.name}/contents`,
      {
        method: "POST",
        token: bobToken,
        body: JSON.stringify({
          branch: "refined",
          message: "refine",
          files: [{ path: "e.txt", content: "five\n" }],
        }),
      },
    );
    expect(committed.status).toBe(201);
    const { commitOid } = await read<{ commitOid: string }>(committed);
    const propose = (token: string) =>
      api(`/api/v1/repos/${mirror.ownerName}/${mirror.name}/pulls`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "refined",
          base: "main",
          head: "refined",
          headRepo: `${fork.ownerName}/${fork.name}`,
        }),
      });
    // The branch travels under the connecting account's credential, so
    // only that account may send it.
    expect((await propose(bobToken)).status).toBe(403);
    const proposed = await propose(aliceToken);
    expect(proposed.status).toBe(201);
    const pull = await read<{ number: number }>(proposed);

    // The branch is on the upstream's own git, at bob's commit…
    const branches = await (await read<{ items: { name: string; oid: string }[] }>(await fetch(`${originServers.url}/api/v1/repos/${ORIGIN_LOGIN}/own/branches`))).items;
    expect(branches.find((b) => b.name === "refined")?.oid).toBe(commitOid);
    // …the pull was opened there from it, as a bare branch…
    const opened = forgejo.state.requests.filter(
      (r) =>
        r.method === "POST" && r.path.endsWith(`/${ORIGIN_LOGIN}/own/pulls`),
    );
    const sent = JSON.parse(opened.at(-1)!.body) as Record<string, unknown>;
    expect(sent.head).toBe("refined");
    expect(sent.base).toBe("main");
    // …and the mirror shows both the branch and the pull.
    const local = await read<{ items: { name: string; oid: string }[] }>(
      await api(`/api/v1/repos/${mirror.ownerName}/${mirror.name}/branches`),
    );
    expect(local.items.find((b) => b.name === "refined")?.oid).toBe(commitOid);
    const listed = await read<{ items: { number: number }[] }>(
      await api(`/api/v1/repos/${mirror.ownerName}/${mirror.name}/pulls`),
    );
    expect(listed.items.map((p) => p.number)).toContain(pull.number);
  });

  test("a mirror whose git is not ready yet is fetched again, and lands", async () => {
    // The origin's API knows the repository before its git answers — what
    // a freshly made fork looks like for a moment. The row is in the fake
    // now; the git host gets the repository a second later.
    forgejo.state.repos.push({
      id: 900,
      fullName: `${UPSTREAM_OWNER}/late`,
      defaultBranch: "main",
      cloneUrl: `${originServers.url}/${UPSTREAM_OWNER}/late.git`,
      push: false,
      admin: false,
    });
    // The first fetch must find nothing and the retry must find the whole
    // repository. Making it is two requests (create, then commit), so a
    // retry on a timer can land between them and fetch it empty, and a
    // test that polls for "the first fetch has failed" can miss the
    // moment (#541). Instead the retry's wait *is* the seeding: the first
    // fetch runs before anything exists, and the second only once both
    // requests have answered.
    const found = { ...firstFetchRetry };
    let seeded = 0;
    firstFetchRetry.ms = [0];
    firstFetchRetry.wait = async () => {
      seeded++;
      await seedUpstream("late");
    };
    let job: Awaited<ReturnType<typeof mirrorAndWait>>;
    try {
      const started = await api(
        `/api/v1/user/origins/${forgejoOrigin}/mirror`,
        {
          method: "POST",
          body: JSON.stringify({ fullName: `${UPSTREAM_OWNER}/late` }),
        },
      );
      expect(started.status).toBe(202);
      job = await mirrorAndWait(started);
    } finally {
      Object.assign(firstFetchRetry, found);
    }
    // Tried twice: once before the repository existed, once after.
    expect(seeded).toBe(1);
    expect(job?.stage).toBe("done");
    expect(job?.repo?.name).toBe("late");
    const branches = await read<{ items: { name: string }[] }>(
      await api(`/api/v1/repos/${job!.repo!.ownerName}/late/branches`),
    );
    expect(branches.items.map((b) => b.name)).toContain("main");
  }, 60_000);

  test("a native repo has no upstream to contribute to", async () => {
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "mine", visibility: "public" }),
    });
    const refused = await api("/api/v1/repos/alice/mine/contribute", {
      method: "POST",
      body: JSON.stringify({
        branch: "x",
        files: [{ path: "a.txt", content: "a\n" }],
      }),
    });
    expect(refused.status).toBe(404);
  });
});
