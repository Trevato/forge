/**
 * Watching a milestone: a person presses Watch once, its progress is one
 * item in their feed that follows it, and their phone hears once, when it
 * lands.
 *
 * The refusals come first: nobody, an agent, a read token, a repository
 * that cannot be seen, an issue that is no milestone and a post from another
 * origin watch nothing. Then the watch is each person's own; the feed says
 * nothing until the milestone moves and then one item, renamed as it goes;
 * landing pages once and progress never; a dropped milestone says so and
 * does not page; and someone who can no longer read the repository hears
 * and sees nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { isWatching } from "../src/core/watches.ts";
import {
  setNotifyUrl,
  startNotifier,
  type Notifier,
  type Sender,
} from "../src/crew/notify.ts";
import { readFeed } from "../src/feed/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";

const URL_A = "https://ntfy.example.test/alice-secret-topic";
const URL_B = "https://ntfy.example.test/bob-secret-topic";

describe("watching a milestone", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let notifier: Notifier;
  let alice: User;
  let bob: User;
  let mason: User;
  let engine: Repo;
  let secret: Repo;
  /** `release` waits for four parts; `gamma` and `delta` for one each. */
  let release: Issue;
  let parts: Issue[];
  let gamma: Issue;
  let delta: Issue;
  let hidden: Issue;
  const posts: { url: string; body: string; click: string }[] = [];
  const send: Sender = async (url, body, headers) => {
    posts.push({ url, body, click: headers["click"] ?? "" });
    return true;
  };
  const cookies: Record<string, string> = {};

  const fresh = (repo: Repo) => getRepoById(app.db, repo.id)!;
  const current = (issue: Issue) => getIssueById(app.db, issue.id)!;
  const issue = (repo: Repo, title: string): Issue => {
    const opened = openIssue(app, alice, fresh(repo), { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  /** A milestone: an issue that waits for one part for each title. */
  const milestone = (repo: Repo, title: string, ...titles: string[]) => {
    const top = issue(repo, title);
    const under = titles.map((t) => issue(repo, t));
    for (const part of under) {
      const linked = linkIssue(app, alice, fresh(repo), current(top), part);
      if (!linked.ok) throw new Error(String(linked.error));
    }
    return { top, under };
  };
  let branches = 0;
  /** A pull that closes `closes`, merged: how the crew finishes an issue. */
  const land = async (closes: Issue, title: string): Promise<void> => {
    const name = `part-${branches++}`;
    const pushed = await commitToBranch(app, alice, fresh(engine), {
      branch: `feature/${name}`,
      base: "main",
      message: title,
      files: [{ path: `${name}.md`, content: `${name}\n` }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, fresh(engine), {
      title,
      body: `Closes #${closes.number}`,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(app, alice, fresh(engine), opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    await notifier.settled();
  };
  const watched = (who: User) =>
    readFeed(app.db, who, { limit: 50 }).items.filter(
      (i) => i.kind === "milestone",
    );
  const rows = (): number =>
    app.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM milestone_watch")
      .get()!.n;
  const tokenOf = (user: User, scope: "ro" | "rw"): string =>
    createToken(app.db, user.id, scope, scope).token;
  const call = (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const at = (m: Issue, repo = "engine") =>
    `/api/v1/repos/alice/${repo}/milestones/${m.number}`;
  const page = (m: Issue, repo = "engine") =>
    `/alice/${repo}/milestones/${m.number}`;
  const press = (who: string, m: Issue, watch: "0" | "1", origin = base) =>
    fetch(`${base}${page(m)}/watch`, {
      method: "POST",
      headers: {
        ...(who === "" ? {} : { cookie: cookies[who]! }),
        origin,
      },
      body: new URLSearchParams({ watch }),
      redirect: "manual",
    });
  let nextId = 1;
  const tool = async (token: string, name: string, args: unknown) => {
    const res = await call("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const answer = (await res.json()) as any;
    const text: string = answer.result.content[0].text;
    return answer.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-watches-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const [username, adminIfFirst] of [
      ["alice", true],
      ["bob", false],
    ] as const) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      cookies[username] = (
        (
          await fetch(`${base}/signin`, {
            method: "POST",
            body: new URLSearchParams({
              username,
              password: "a-good-passphrase",
            }),
            redirect: "manual",
          })
        ).headers.get("set-cookie") ?? ""
      ).split(";")[0]!;
    }
    alice = getUserByName(app.db, "alice")!;
    bob = getUserByName(app.db, "bob")!;
    const repoOf = async (name: string, visibility: "public" | "private") => {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const seeded = await commitToBranch(app, alice, made.value, {
        message: "Start",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      return made.value;
    };
    // Public: bob reads the engine and writes nothing there.
    engine = await repoOf("engine", "public");
    secret = await repoOf("secret", "private");
    const agent = await createAgent(app, alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, engine, "mason").ok).toBe(true);
    mason = getUserByName(app.db, "mason")!;

    ({ top: release, under: parts } = milestone(
      engine,
      "Release one",
      "Part a",
      "Part b",
      "Part c",
      "Part d",
    ));
    gamma = milestone(engine, "Gamma", "Gamma's one part").top;
    delta = milestone(engine, "Delta", "Delta's one part").top;
    hidden = milestone(secret, "A hidden milestone", "Its part").top;

    expect(setNotifyUrl(app.db, alice.id, URL_A).ok).toBe(true);
    expect(setNotifyUrl(app.db, bob.id, URL_B).ok).toBe(true);
    notifier = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      send,
    });
    await notifier.settled();
  }, 60_000);

  afterAll(async () => {
    notifier.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("refused: nobody, an agent, a read token, a hidden repository, an issue that is no milestone, another origin", async () => {
    // Nobody signed in.
    expect((await press("", release, "1")).status).toBe(303);
    expect((await call("PUT", `${at(release)}/watch`)).status).toBe(401);
    // A read token reads; it does not watch.
    expect(
      (await call("PUT", `${at(release)}/watch`, tokenOf(bob, "ro"))).status,
    ).toBe(403);
    expect(
      (
        await tool(tokenOf(bob, "ro"), "watch", {
          app: "alice/engine",
          issue: release.number,
        })
      ).error,
    ).toContain("forbidden");
    // An agent has no feed and no phone.
    expect(
      (await call("PUT", `${at(release)}/watch`, tokenOf(mason, "rw"))).status,
    ).toBe(403);
    expect(
      (
        await tool(tokenOf(mason, "rw"), "watch", {
          app: "alice/engine",
          issue: release.number,
        })
      ).error,
    ).toContain("forbidden");
    // A repository bob cannot see: one answer, as for no repository at all.
    expect(
      (await call("PUT", `${at(hidden, "secret")}/watch`, tokenOf(bob, "rw")))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}${page(hidden, "secret")}/watch`, {
          method: "POST",
          headers: { cookie: cookies["bob"]!, origin: base },
          body: new URLSearchParams({ watch: "1" }),
          redirect: "manual",
        })
      ).status,
    ).toBe(404);
    // An issue that waits for nothing is no milestone; nor is a number nothing has.
    for (const number of [parts[0]!.number, 9999])
      expect(
        (
          await call(
            "PUT",
            `/api/v1/repos/alice/engine/milestones/${number}/watch`,
            tokenOf(bob, "rw"),
          )
        ).status,
      ).toBe(404);
    // A post from another origin, with alice's own session.
    expect(
      (await press("alice", release, "1", "https://evil.test")).status,
    ).toBe(403);
    expect(rows()).toBe(0);
  });

  test("the button is each person's own: press to watch, again to stop, and the read says which", async () => {
    const before = await (
      await fetch(`${base}${page(release)}`, {
        headers: { cookie: cookies["bob"]! },
      })
    ).text();
    expect(before).toContain('id="ms-watch"');
    expect(before).toContain('name="watch" value="1"');
    // Signed out, there is nothing to press.
    expect(await (await fetch(`${base}${page(release)}`)).text()).not.toContain(
      'id="ms-watch"',
    );
    const pressed = await press("bob", release, "1");
    expect(pressed.status).toBe(303);
    expect(pressed.headers.get("location")).toBe(page(release));
    expect(isWatching(app.db, bob.id, release.id)).toBe(true);
    const after = await (
      await fetch(`${base}${page(release)}`, {
        headers: { cookie: cookies["bob"]! },
      })
    ).text();
    expect(after).toContain("Watching");
    expect(after).toContain('name="watch" value="0"');
    // alice has pressed nothing.
    expect(
      await (
        await fetch(`${base}${page(release)}`, {
          headers: { cookie: cookies["alice"]! },
        })
      ).text(),
    ).toContain('name="watch" value="1"');
    const read = async (token?: string) =>
      (await (await call("GET", at(release), token)).json()) as {
        watching?: boolean;
      };
    expect((await read(tokenOf(bob, "ro"))).watching).toBe(true);
    expect((await read(tokenOf(alice, "ro"))).watching).toBe(false);
    expect("watching" in (await read())).toBe(false);
    expect(
      (
        await tool(tokenOf(bob, "ro"), "milestones", {
          app: "alice/engine",
          issue: release.number,
        })
      ).value.watching,
    ).toBe(true);
    // Again stops; and each way, twice is the same as once.
    expect((await press("bob", release, "0")).status).toBe(303);
    expect(isWatching(app.db, bob.id, release.id)).toBe(false);
    const rw = tokenOf(bob, "rw");
    for (let n = 0; n < 2; n++) {
      const put = await call("PUT", `${at(release)}/watch`, rw);
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ watching: true });
    }
    expect(rows()).toBe(1);
    const stop = { app: "alice/engine", issue: release.number, watch: false };
    expect((await tool(rw, "watch", stop)).value).toEqual({ watching: false });
    expect((await tool(rw, "watch", stop)).value).toEqual({ watching: false });
    expect(rows()).toBe(0);
    expect(
      (await tool(rw, "watch", { app: "alice/engine", issue: release.number }))
        .value,
    ).toEqual({ watching: true });
    const del = await call("DELETE", `${at(release)}/watch`, rw);
    expect(await del.json()).toEqual({ watching: false });
    expect((await press("bob", release, "1")).status).toBe(303);
    expect(rows()).toBe(1);
  });

  test("the feed says nothing until it moves, then one item that follows the milestone", async () => {
    expect(watched(bob)).toEqual([]);
    await Bun.sleep(5);
    await land(parts[0]!, "Add part a");
    const first = watched(bob);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: `milestone:${release.id}:1-4`,
      app: "alice/engine",
      link: page(release),
      reason:
        "“Release one” is 1 of 4 done: 1 merged since you last looked (Add part a)",
    });
    // One item, not one for each pull: it is renamed as the milestone moves.
    await land(parts[1]!, "Add part b");
    const second = watched(bob);
    expect(second.map((i) => i.id)).toEqual([`milestone:${release.id}:2-4`]);
    expect(second[0]!.reason).toContain("2 of 4 done: 2 merged since you last looked");
    // It is bob's: alice watches nothing and sees none of it.
    expect(watched(alice)).toEqual([]);
    // Muting the app does not mute what he chose to watch.
    const rw = tokenOf(bob, "rw");
    const act = (kind: string, item: string) =>
      call("POST", "/api/v1/feed/interactions", rw, {
        item,
        kind,
        app: "alice/engine",
      });
    expect((await act("muted", second[0]!.id)).status).toBe(201);
    expect(watched(bob)).toHaveLength(1);
    // He opens it: nothing is new, so it says nothing, until the next merge.
    expect((await act("opened", second[0]!.id)).status).toBe(201);
    expect(watched(bob)).toEqual([]);
    await Bun.sleep(5);
    await land(parts[2]!, "Add part c");
    const third = watched(bob);
    expect(third.map((i) => i.id)).toEqual([`milestone:${release.id}:3-4`]);
    expect(third[0]!.reason).toBe(
      "“Release one” is 3 of 4 done: 1 merged since you last looked (Add part c)",
    );
    // Dismissed holds for this much progress, and no longer.
    expect((await act("dismissed", third[0]!.id)).status).toBe(201);
    expect(watched(bob)).toEqual([]);
    // None of this reached a phone: progress never does.
    expect(posts).toEqual([]);
  });

  test("it lands: the feed says so, and the phone hears once, with a link to it", async () => {
    // Its last open issue closes: that is the landing, its own issue still open.
    await land(parts[3]!, "Add part d");
    expect(current(release).state).toBe("open");
    const mine = posts.filter((p) => p.url === URL_B);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toBe(
      `engine: “Release one” landed, 4 of 4 done\nhttps://forge.example.test${page(release)}`,
    );
    expect(mine[0]!.click).toBe(`https://forge.example.test${page(release)}`);
    expect(watched(bob)).toMatchObject([
      {
        id: `milestone:${release.id}:landed`,
        reason: "“Release one” landed: 4 of 4 done",
      },
    ]);
    // Closing its own issue as done is the same landing, not a second one.
    const closed = setIssueState(app, alice, fresh(engine), current(release), "closed", {
      reason: "done",
    });
    expect(closed.ok).toBe(true);
    await notifier.settled();
    expect(posts.filter((p) => p.url === URL_B)).toHaveLength(1);
    expect(watched(bob).map((i) => i.id)).toEqual([
      `milestone:${release.id}:landed`,
    ]);
    // alice watched nothing: her phone heard nothing of it.
    expect(posts.filter((p) => p.url === URL_A && p.body.includes("landed"))).toEqual(
      [],
    );
  });

  test("dropped: the feed says it will not land, and the phone is not told", async () => {
    expect((await press("bob", gamma, "1")).status).toBe(303);
    const before = posts.length;
    const closed = setIssueState(app, alice, fresh(engine), current(gamma), "closed", {
      reason: "dropped",
    });
    expect(closed.ok).toBe(true);
    await notifier.settled();
    expect(
      watched(bob).find((i) => i.id === `milestone:${gamma.id}:dropped`)!.reason,
    ).toBe("“Gamma” was dropped: it will not land as it was written");
    expect(posts.length).toBe(before);
  });

  test("a watch on a repository he can no longer read says nothing, anywhere", async () => {
    // Both watch Delta; then the engine goes private, and Delta lands.
    expect((await press("bob", delta, "1")).status).toBe(303);
    expect((await press("alice", delta, "1")).status).toBe(303);
    const made = await updateRepoSettings(app, alice, fresh(engine), {
      visibility: "private",
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    await notifier.settled();
    const before = posts.filter((p) => p.url === URL_B).length;
    await Bun.sleep(5);
    const part = app.db
      .query<{ id: string }, [string]>(
        "SELECT blocked_by_id AS id FROM issue_dependency WHERE issue_id = ?1",
      )
      .get(delta.id)!;
    await land(getIssueById(app.db, part.id)!, "Add delta's part");
    // alice still reads it: her phone hears, and her feed says.
    expect(
      posts.filter((p) => p.url === URL_A).map((p) => p.body.split("\n")[0]),
    ).toContain("engine: “Delta” landed, 1 of 1 done");
    expect(watched(alice).map((i) => i.id)).toContain(
      `milestone:${delta.id}:landed`,
    );
    // bob does not: nothing new on his phone, nothing of the engine in his
    // feed — not even what he was shown before — and no way to ask.
    expect(posts.filter((p) => p.url === URL_B)).toHaveLength(before);
    expect(watched(bob)).toEqual([]);
    const rw = tokenOf(bob, "rw");
    expect((await call("GET", at(delta), rw)).status).toBe(404);
    expect((await call("PUT", `${at(delta)}/watch`, rw)).status).toBe(404);
    expect((await call("DELETE", `${at(delta)}/watch`, rw)).status).toBe(404);
    // The row is still his, and says nothing while he cannot read.
    expect(isWatching(app.db, bob.id, delta.id)).toBe(true);
  });
});
