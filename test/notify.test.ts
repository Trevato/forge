/**
 * Something that newly needs you reaches your phone: one POST per ask, none
 * for what was already told, none for what the person cannot read, and a URL
 * that cannot be turned on the network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { announceRun } from "../src/actions/runs.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { post } from "../src/crew/notify.ts";
import {
  notifyHost,
  notifyUrlOf,
  parseNotifyUrl,
  setNotifyUrl,
  startNotifier,
  type Notifier,
  type Sender,
} from "../src/crew/notify.ts";

const URL_A = "https://ntfy.example.test/alice-secret-topic";
const URL_B = "https://ntfy.example.test/bob-secret-topic";

describe("notify", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let notifier: Notifier;
  const posts: { url: string; body: string }[] = [];
  let healthy = true;
  let clock = 1_000_000;
  const send: Sender = async (url, body) => {
    posts.push({ url, body });
    return healthy;
  };

  const user = async (username: string, first = false): Promise<User> => {
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  /** A green pull, announced the way the checks worker announces it. */
  async function greenPull(n: number, title: string): Promise<void> {
    const branch = await commitToBranch(app, alice, repo, {
      branch: `feature/n${n}`,
      base: "main",
      message: title,
      files: [{ path: `N${n}.md`, content: `${n}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title,
      body: "",
      baseBranch: "main",
      headBranch: `feature/n${n}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: opened.value.id,
      env: `pull-${opened.value.number}`,
      commitOid: opened.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    const done = finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    announceRun(app, done!);
    await notifier.settled();
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-notify-"));
    app = createApp({ dataDir, port: 0 });
    alice = await user("alice", true);
    bob = await user("bob");
    const made = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    expect(setNotifyUrl(app.db, alice.id, URL_A).ok).toBe(true);
    expect(setNotifyUrl(app.db, bob.id, URL_B).ok).toBe(true);
    notifier = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      send,
      now: () => clock,
    });
    await notifier.settled();
  });
  afterAll(async () => {
    await notifier.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a green pull sends one POST with a link to the asks screen; the same pull again sends none", async () => {
    await greenPull(1, "Add a bench");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(URL_A);
    expect(posts[0]!.body).toContain("Add a bench");
    expect(posts[0]!.body).toContain("https://forge.example.test/");
    // The same pull, announced again: nothing new asks.
    announceRun(
      app,
      createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        env: "main",
        commitOid: "0".repeat(40),
        reason: "push",
      }),
    );
    await notifier.settled();
    expect(posts).toHaveLength(1);
  });

  test("a person who cannot read the private repository is told nothing of it", () => {
    expect(posts.some((p) => p.url === URL_B)).toBe(false);
    expect(posts.some((p) => p.body.includes("bench") && p.url === URL_B)).toBe(
      false,
    );
  });

  test("a failing endpoint is paused, not retried; the pause ends", async () => {
    healthy = false;
    await greenPull(2, "Second");
    expect(posts).toHaveLength(2);
    await greenPull(3, "Third");
    expect(posts).toHaveLength(2); // paused: dropped, not retried
    healthy = true;
    clock += 3_600_000 + 1;
    await greenPull(4, "Fourth");
    expect(posts).toHaveLength(3);
  });

  test("at most ten an hour per person", async () => {
    const before = posts.length;
    // The fourth pull already spent one of this hour's ten.
    for (let i = 5; i < 20; i++) await greenPull(i, `Pull ${i}`);
    expect(posts.length - before).toBe(9);
  });
});

describe("the real sender", () => {
  test("a plain-http or private URL is a message not sent, not a throw", async () => {
    expect(await post("http://ntfy.example.test/t", "x", {})).toBe(false);
    expect(await post("https://127.0.0.1:9/t", "x", {})).toBe(false);
  });
});

describe("the notify URL", () => {
  test("an http: URL is refused; so are credentials, long, private and loopback hosts", () => {
    const refused = (u: string) => {
      const r = parseNotifyUrl(u);
      return r.ok ? "ok" : r.error;
    };
    expect(refused("http://ntfy.sh/topic")).toBe("not_https");
    expect(refused("https://user:pw@ntfy.sh/topic")).toBe("credentials");
    expect(refused("https://ntfy.sh/" + "a".repeat(200))).toBe("too_long");
    expect(refused("not a url")).toBe("invalid_url");
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "0x7f.1",
      "2130706433",
      "[::1]",
      "intranet",
      "box.local",
    ])
      expect(refused(`https://${host}/t`)).toBe("private_host");
    expect(refused("https://ntfy.sh/topic")).toBe("ok");
  });

  test("only the host is ever shown", () => {
    expect(notifyHost("https://ntfy.example.test/secret-topic")).toBe(
      "ntfy.example.test",
    );
  });
});

describe("the account page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;
  let alice: User;
  const secret = "https://ntfy.example.test/very-secret-topic";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-notify-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-long-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-long-passphrase",
      }),
      redirect: "manual",
    });
    cookie = signin.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const save = (url: string, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}/settings/notify`, {
      method: "POST",
      headers: { cookie, ...headers },
      body: new URLSearchParams({ url }),
      redirect: "manual",
    });

  test("an http: URL is refused and nothing is stored; a good one is stored and only its host shown", async () => {
    const refused = await save("http://ntfy.example.test/t");
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("Only https:");
    expect(notifyUrlOf(app.db, alice.id)).toBeUndefined();

    const saved = await save(secret);
    expect(saved.status).toBe(303);
    expect(notifyUrlOf(app.db, alice.id)).toBe(secret);
    const page = await (
      await fetch(`${servers.url}/settings`, { headers: { cookie } })
    ).text();
    expect(page).toContain("ntfy.example.test");
    expect(page).not.toContain("very-secret-topic");
  });

  test("a cross-origin post changes nothing; an empty one turns it off", async () => {
    const cross = await save("https://evil.example.test/x", {
      origin: "https://evil.example.test",
    });
    expect(cross.status).toBe(403);
    expect(notifyUrlOf(app.db, alice.id)).toBe(secret);
    await save("");
    expect(notifyUrlOf(app.db, alice.id)).toBeUndefined();
  });
});
