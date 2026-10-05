import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "X",
  GIT_AUTHOR_EMAIL: "x@f.dev",
  GIT_COMMITTER_NAME: "X",
  GIT_COMMITTER_EMAIL: "x@f.dev",
});

describe("cross-repo pull requests (fork → upstream)", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let aliceToken = "";
  let bobToken = "";
  let aliceCookie = "";
  let bobCookie = "";

  async function gitOk(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  const form = (f: Record<string, string>) => new URLSearchParams(f);

  async function mkUser(
    username: string,
  ): Promise<{ token: string; cookie: string }> {
    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username,
        email: `${username}@f.dev`,
        password: "cross-repo-pass",
      }),
      redirect: "manual",
    });
    const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    const token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username,
        password: "cross-repo-pass",
        name: "c",
        scope: "admin",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    return { token, cookie };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-xr-"));
    work = await mkdtemp(join(tmpdir(), "forge-xr-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    ({ token: aliceToken, cookie: aliceCookie } = await mkUser("alice"));
    ({ token: bobToken, cookie: bobCookie } = await mkUser("bob"));
    proveAll(app);

    // Alice's upstream repo with a seed commit.
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${aliceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    const remote = `${base.replace("http://", `http://alice:${aliceToken}@`)}/alice/app.git`;
    await gitOk(["clone", remote, "app"], work);
    const dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "one\ntwo\nthree\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "seed"], dir);
    await gitOk(["push", "origin", "main"], dir);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("bob forks, pushes a change, and opens a PR against alice's repo", async () => {
    // Fork.
    await fetch(`${base}/api/v1/repos/alice/app/forks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // Bob pushes a change to his fork.
    const forkRemote = `${base.replace("http://", `http://bob:${bobToken}@`)}/bob/app.git`;
    await gitOk(["clone", forkRemote, "bob-app"], work);
    const dir = join(work, "bob-app");
    await Bun.write(join(dir, "code.txt"), "one\nTWO\nthree\n");
    await gitOk(["commit", "-am", "shout two"], dir);
    await gitOk(["push", "origin", "main"], dir);

    // Bob opens the PR from his fork, targeting the parent (baseRepo=parent).
    const opened = await fetch(`${base}/bob/app/pulls/new`, {
      method: "POST",
      headers: { cookie: bobCookie },
      body: form({
        baseRepo: "parent",
        base: "main",
        head: "main",
        title: "Shout two",
        body: "louder",
      }),
      redirect: "manual",
    });
    expect(opened.status).toBe(303);
    // The PR is created on ALICE's repo, not bob's.
    expect(opened.headers.get("location")).toBe("/alice/app/pulls/1");
  });

  test("the PR on the upstream shows the fork's diff and is mergeable", async () => {
    const pr = await (
      await fetch(`${base}/alice/app/pulls/1/files`, {
        headers: { cookie: aliceCookie },
      })
    ).text();
    expect(pr).toContain("Shout two");
    expect(pr).toContain("TWO"); // bob's change is visible in alice's repo
    expect(pr).toContain("Ready to merge");
  });

  test("alice merges it; her main gains bob's commit", async () => {
    const merged = await fetch(`${base}/alice/app/pulls/1/merge`, {
      method: "POST",
      headers: { cookie: aliceCookie },
      body: form({ strategy: "merge" }),
      redirect: "manual",
    });
    expect(merged.status).toBe(303);

    const blob = await (
      await fetch(`${base}/alice/app/blob/main/code.txt`)
    ).text();
    expect(blob).toContain("TWO");

    // The head and merged refs live in the base (alice's) repo.
    const refs = await gitOk(
      [
        "-C",
        join(dataDir, "repos/alice/app.git"),
        "for-each-ref",
        "--format=%(refname)",
        "refs/pull/",
      ],
      work,
    );
    expect(refs).toContain("refs/pull/1/head");
    expect(refs).toContain("refs/pull/1/merged");
  });

  // ---- the same workflow, driven entirely through the API ----
  //
  // The web has always been able to propose a fork's branch upstream. An
  // agent has to be able to do it too, and through the same action — so this
  // is the whole loop with no browser in it: edit on the fork, open the pull
  // across repositories, watch it follow a later push, merge it.

  const json = async <T>(response: Response): Promise<T> =>
    (await response.json()) as T;

  const call = (
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });

  test("an edit on a fork opens a cross-repo pull through the API", async () => {
    // Alice's repo needs a second branch to target so the fork has somewhere
    // to aim that is not the branch it just merged into.
    const edited = await call("/api/v1/repos/bob/app/edits", bobToken, {
      method: "POST",
      body: JSON.stringify({
        newBranch: "api-topic",
        base: "main",
        message: "from the API",
        files: [{ path: "api.txt", content: "written by an agent\n" }],
      }),
    });
    expect(edited.status).toBe(201);
    const commit = await json<{ commit: { commitOid: string } }>(edited);

    // `headRepo` is what makes it cross-repo, and it is the same string the
    // web form sends: `owner/name`.
    const opened = await call("/api/v1/repos/alice/app/pulls", bobToken, {
      method: "POST",
      body: JSON.stringify({
        title: "from the API",
        body: "proposed by an agent",
        base: "main",
        head: "api-topic",
        headRepo: "bob/app",
      }),
    });
    expect(opened.status).toBe(201);
    const pull = await json<{ number: number; crossRepo: boolean }>(opened);
    expect(pull.crossRepo).toBe(true);

    const detail = await json<{
      status: { headOid: string; mergeable: boolean };
      diff: { files: { path: string }[] };
    }>(
      await call(`/api/v1/repos/alice/app/pulls/${pull.number}`, aliceToken),
    );
    expect(detail.status.headOid).toBe(commit.commit.commitOid);
    expect(detail.diff.files.map((f) => f.path)).toContain("api.txt");
    expect(detail.status.mergeable).toBe(true);
  });

  test("a fork that pushes again is reviewed at its new tip, not the old one", async () => {
    const pulls = await json<{ items: { number: number }[] }>(
      await call("/api/v1/repos/alice/app/pulls?state=open", aliceToken),
    );
    const number = pulls.items[0]!.number;

    // Bob pushes more work to the same branch, in his own repository. The
    // base repo holds only a snapshot of it (`refs/pull/N/head`), so unless
    // that is refreshed the reviewer is reading a commit nobody proposes.
    const again = await call("/api/v1/repos/bob/app/edits", bobToken, {
      method: "POST",
      body: JSON.stringify({
        branch: "api-topic",
        message: "second thoughts",
        files: [{ path: "api.txt", content: "written by an agent, twice\n" }],
      }),
    });
    expect(again.status).toBe(201);
    const second = await json<{ commit: { commitOid: string } }>(again);

    const detail = await json<{ status: { headOid: string } }>(
      await call(`/api/v1/repos/alice/app/pulls/${number}`, aliceToken),
    );
    expect(detail.status.headOid).toBe(second.commit.commitOid);

    // The durable ref moved with it, which is what any client fetching
    // `refs/pull/N/head` is entitled to expect.
    const head = await gitOk(
      [
        "-C",
        join(dataDir, "repos/alice/app.git"),
        "rev-parse",
        `refs/pull/${number}/head`,
      ],
      work,
    );
    expect(head).toBe(second.commit.commitOid);

    const merged = await call(
      `/api/v1/repos/alice/app/pulls/${number}/merge`,
      aliceToken,
      { method: "POST", body: JSON.stringify({ strategy: "squash" }) },
    );
    expect(merged.status).toBe(200);
    const blob = await (
      await fetch(`${base}/api/v1/repos/alice/app/contents/api.txt?ref=main`)
    ).json();
    expect(JSON.stringify(blob)).toContain("twice");
  });

  test("a head repo that is not a fork of this base is not_found", async () => {
    // Bob makes an unrelated repository and tries to propose it upstream.
    await call("/api/v1/repos", bobToken, {
      method: "POST",
      body: JSON.stringify({ name: "unrelated", visibility: "public" }),
    });
    await call("/api/v1/repos/bob/unrelated/edits", bobToken, {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "seed",
        files: [{ path: "x.txt", content: "x\n" }],
      }),
    });
    const refused = await call("/api/v1/repos/alice/app/pulls", bobToken, {
      method: "POST",
      body: JSON.stringify({
        title: "sneaky",
        base: "main",
        head: "main",
        headRepo: "bob/unrelated",
      }),
    });
    expect(refused.status).toBe(404);
  });
});
