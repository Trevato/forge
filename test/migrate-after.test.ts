/**
 * What happens to the GitHub repository after a migration (#3408): left
 * alone, archived there, or kept as a read-only mirror the forge pushes to.
 * The source is a repository on this forge standing in for GitHub's git
 * side; the fake GitHub's request log is the API side.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { afterChoice, migrateRepo } from "../src/actions/migrate.ts";
import { connectOrigin } from "../src/actions/origins.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getMirrorTarget, mirrorLine } from "../src/core/migrate_mirror.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { runGitCapture } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { settled } from "../src/origins/jobs.ts";
import { pushToMirrorTarget } from "../src/origins/push-through.ts";
import { startMirrorOut } from "../src/origins/mirror-out.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();
// Git and a fake forge under a loaded check machine outlast bun's 5 s default.
// The test's own limit sits above the longest wait inside it (`settledTarget`'s
// deadline), so a slow push is waited for, never cut off as a timeout.
setDefaultTimeout(120_000);

describe("migrate: after", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let github: FakeForge;
  let alice: User;
  let octo: User;
  let originId = "";
  let stopMirror = async () => {};
  let n = 0;

  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.test`,
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(String(made.error));
    promote(app.db, made.value);
    return made.value;
  };

  const commit = async (user: User, owner: string, name: string, path: string) => {
    const repo = getRepo(app.db, owner, name)!;
    const done = await commitToBranch(app, user, repo, {
      branch: "main",
      message: path,
      files: [{ path, content: `${path}\n` }],
    });
    if (!done.ok) throw new Error(String(done.error));
  };

  /** A fresh GitHub repository (octo's, on this forge), migrated by alice. */
  const migrate = async (after: "leave" | "archive" | "mirror", admin = true) => {
    const name = `gizmo${++n}`;
    const made = await createRepo(app, octo, { name, visibility: "private" });
    if (!made.ok) throw new Error(made.error);
    await commit(octo, "octo", name, "README.md");
    github.state.repos.push({
      id: 100 + n,
      fullName: `octo/${name}`,
      cloneUrl: `http://127.0.0.1:${servers.port}/octo/${name}.git`,
      defaultBranch: "main",
      private: true,
      admin,
      push: true,
    });
    github.state.requests.length = 0;
    const started = await migrateRepo(app, alice, {
      source: { originId, fullName: `octo/${name}` },
      name: `copy${n}`,
      after,
    });
    if (!started.ok) throw new Error(started.error);
    const job = await settled(started.value.job.id);
    return { name, job, copy: `copy${n}` };
  };

  /** Wakers for whoever waits on a mirror push to end. */
  const pushEnded = new Set<() => void>();

  const writes = () =>
    github.state.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-migrate-after-"));
    app = createApp({ dataDir, port: 0, migrateFromPrivateHosts: true });
    servers = await serve(app);
    alice = await person("alice");
    octo = await person("octo");
    const secret = createToken(app.db, octo.id, "upstream", "rw").token;
    github = serveFakeForge(newFakeState("github", "octo", secret));
    forgetProviders(dataDir);
    const connected = await connectOrigin(app, alice, {
      host: github.url,
      kind: "github",
      token: secret,
    });
    if (!connected.ok) throw new Error(JSON.stringify(connected.error));
    originId = connected.value.id;
    stopMirror = startMirrorOut(app, async (a, repo) => {
      try {
        return await pushToMirrorTarget(a, repo);
      } finally {
        const waiting = [...pushEnded];
        pushEnded.clear();
        for (const wake of waiting) wake();
      }
    });
  }, 120_000);

  afterAll(async () => {
    // Pushes still running read the database and the repositories: let them
    // end before either goes, whatever the machine's load.
    await stopMirror();
    github.stop();
    servers.stop();
    try {
      app.close();
    } catch {
      // A late write on a closing database is not what these tests judge.
    }
    forgetProviders(dataDir);
    // A mirror push or git child may still be writing as the app closes; the
    // directory goes once they let go. A scratch directory that will not go
    // is the machine's to sweep, not a verdict on the code under test.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 }).catch(() => {});
  }, 120_000);

  test("the form's word: anything but archive or mirror leaves it alone", () => {
    expect(afterChoice("archive")).toBe("archive");
    expect(afterChoice("mirror")).toBe("mirror");
    expect(afterChoice("")).toBe("leave");
    expect(afterChoice("delete")).toBe("leave");
  });

  test("/migrate offers the three choices, leaving it alone by default", async () => {
    const html = await (
      await fetch(`http://127.0.0.1:${servers.port}/migrate`, {
        headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
      })
    ).text();
    expect(html).toContain('name="after"');
    expect(html).toMatch(/<option\s[^>]*value="leave"[^>]*selected|<option\s[^>]*selected[^>]*value="leave"/);
    expect(html).toContain('value="archive"');
    expect(html).toContain('value="mirror"');
  });

  test("leave alone: no write reaches GitHub, and no mirror is kept", async () => {
    const { job, copy } = await migrate("leave");
    expect(job?.stage).toBe("done");
    expect(writes()).toEqual([]);
    expect(getMirrorTarget(app.db, getRepo(app.db, "alice", copy)!.id)).toBeUndefined();
  });

  test("archive: one PATCH archived=true under the connected credential", async () => {
    const { job, name } = await migrate("archive");
    expect(job?.stage).toBe("done");
    expect(job?.detail).toContain(`octo/${name} is archived on its origin`);
    const w = writes();
    expect(w.length).toBe(1);
    expect(w[0]!.method).toBe("PATCH");
    expect(w[0]!.path).toMatch(new RegExp(`/repos/octo/${name}$`));
    expect(JSON.parse(w[0]!.body)).toEqual({ archived: true });
    expect(w[0]!.authorization).not.toBe("");
    expect(github.state.repos.find((r) => r.fullName === `octo/${name}`)!.archived).toBe(true);
  });

  test("archive without admin there: said in plain words, the migration still succeeds", async () => {
    const { job, name, copy } = await migrate("archive", false);
    expect(job?.stage).toBe("done");
    expect(job?.detail).toContain(`octo/${name} was not archived: the connected account lacks admin rights there`);
    expect(github.state.repos.find((r) => r.fullName === `octo/${name}`)!.archived).toBeUndefined();
    expect(getRepo(app.db, "alice", copy)).toBeDefined();
  });

  /** The copy's mirror target, once `ok` says a push that has ended left it so. */
  const settledTarget = async (copy: string, ok: (t: NonNullable<ReturnType<typeof getMirrorTarget>>) => boolean) => {
    const id = getRepo(app.db, "alice", copy)!.id;
    const look = () => {
      const held = getMirrorTarget(app.db, id);
      return held !== undefined && ok(held) ? held : undefined;
    };
    // Wait on the event, not the clock: each push that ends wakes the waiters,
    // and the test's own timeout is the only bound.
    for (;;) {
      const held = look();
      if (held) return held;
      await new Promise<void>((resolve) => pushEnded.add(resolve));
    }
  };

  test("mirror: no write at migration, then one push to GitHub after a landing", async () => {
    const { job, name, copy } = await migrate("mirror");
    expect(job?.stage).toBe("done");
    expect(job?.detail).toContain("read-only mirror");
    expect(writes()).toEqual([]);

    const sourceDir = repoDir(app.reposRoot, "octo", name);
    const before = await resolveOid(sourceDir, "refs/heads/main");
    await commit(alice, "alice", copy, "landed.txt");
    const mine = await resolveOid(repoDir(app.reposRoot, "alice", copy), "refs/heads/main");
    expect(mine).not.toBe(before);
    await settledTarget(copy, (t) => t.tips["refs/heads/main"] === mine);
    expect(await resolveOid(sourceDir, "refs/heads/main")).toBe(mine);
    // The credential travelled as a header in git's environment: the API
    // log has no write, and the stored target holds no secret.
    expect(writes()).toEqual([]);
    const target = getMirrorTarget(app.db, getRepo(app.db, "alice", copy)!.id)!;
    expect(target.tips["refs/heads/main"]).toBe(mine!);
    expect(target.lastError).toBe("");
    expect(JSON.stringify(target)).not.toContain("token");
  });

  test("mirror: the crew's work branches never go to the source", async () => {
    const { name, copy } = await migrate("mirror");
    const copyDir = repoDir(app.reposRoot, "alice", copy);
    const main = (await resolveOid(copyDir, "refs/heads/main"))!;
    await runGitCapture(["update-ref", "refs/heads/scout/unreviewed", main], { cwd: copyDir });
    await commit(alice, "alice", copy, "landed.txt");
    const mine = (await resolveOid(copyDir, "refs/heads/main"))!;
    await settledTarget(copy, (t) => t.tips["refs/heads/main"] === mine);
    const sourceDir = repoDir(app.reposRoot, "octo", name);
    expect(await resolveOid(sourceDir, "refs/heads/scout/unreviewed")).toBeUndefined();
    expect(await resolveOid(sourceDir, "refs/heads/main")).toBe(mine);
  });

  test("mirror: a source that moved on its own is not overwritten, and the error is recorded and shown", async () => {
    const { name, copy } = await migrate("mirror");
    const sourceDir = repoDir(app.reposRoot, "octo", name);
    await commit(octo, "octo", name, "theirs.txt");
    const theirs = (await resolveOid(sourceDir, "refs/heads/main"))!;
    await commit(alice, "alice", copy, "landed.txt");
    const held = await settledTarget(copy, (t) => t.lastError !== "");
    expect(held.lastError).toContain(`octo/${name}`);
    expect(await resolveOid(sourceDir, "refs/heads/main")).toBe(theirs);
    expect(mirrorLine(held)).toContain("stopped");

    // The settings page says so, and Stop mirroring is the way out.
    const base = `http://127.0.0.1:${servers.port}`;
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const page = await (await fetch(`${base}/alice/${copy}/settings`, { headers: { cookie } })).text();
    expect(page).toContain(`Mirrored to octo/${name}, stopped:`);
    expect(page).toContain("Stop mirroring");
    const stop = (headers: Record<string, string>) =>
      fetch(`${base}/alice/${copy}/settings/mirror/stop`, { method: "POST", headers, body: "", redirect: "manual" });
    expect((await stop({ cookie, origin: "http://evil.example" })).status).toBe(403);
    expect(getMirrorTarget(app.db, getRepo(app.db, "alice", copy)!.id)).toBeDefined();
    const octoCookie = `forge_session=${createSession(app.db, octo.id).token}`;
    expect((await stop({ cookie: octoCookie, origin: base })).status).toBeGreaterThanOrEqual(400);
    expect(getMirrorTarget(app.db, getRepo(app.db, "alice", copy)!.id)).toBeDefined();
    expect((await stop({ cookie, origin: base })).status).toBe(303);
    expect(getMirrorTarget(app.db, getRepo(app.db, "alice", copy)!.id)).toBeUndefined();
  });
});

// The handler's refusal needs an app and a token, not the fake GitHub, the
// mirror loop or any git work: its own small fixture, so a loaded machine
// slowing the fixture above cannot fail it.
describe("migrate: after, refused at the boundary", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-migrate-after-400-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 120_000);

  test("POST /api/v1/migrate with an unknown `after` is a 400 naming the three words", async () => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(String(made.error));
    const token = createToken(app.db, made.value.id, "api", "admin").token;
    const res = await fetch(`http://127.0.0.1:${servers.port}/api/v1/migrate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ source: { url: "https://github.com/octo/x" }, after: "delete" }),
    });
    expect(res.status).toBe(400);
    const said = JSON.stringify(await res.json());
    expect(said).toContain("leave");
    expect(said).toContain("archive");
    expect(said).toContain("mirror");
  }, 120_000);
});
