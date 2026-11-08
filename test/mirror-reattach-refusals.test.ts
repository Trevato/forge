import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { reattachMirror } from "../src/actions/origins.ts";
import { createOrigin, getOriginById } from "../src/core/origins.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * Reattaching a frozen mirror (#1090) has two refusals that keep it from
 * syncing one repository's history into another: a different remote id
 * (`not_the_same_repo`) and a remote another mirror already holds
 * (`already_mirrored`). Both leave the mirror exactly as it was; a rename,
 * which keeps the remote id, is no reason to refuse.
 */

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-secret-7089";
const PASSWORD = "alice-secret-7089";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("reattaching a frozen mirror", () => {
  let dataDir: string;
  let gitDataDir: string;
  let app: App;
  let servers: Servers;
  let gitApp: App;
  let gitServers: Servers;
  let fake: FakeForge;
  let originId = "";

  const alice = () => getUserByName(app.db, "alice")!;
  const widgets = (): Repo => getRepo(app.db, "alice", "widgets")!;
  const api = (path: string, init?: RequestInit) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: basic("alice", PASSWORD),
      },
    });

  const mirrorMain = () =>
    resolveOid(repoDir(app.reposRoot, "alice", "widgets"), "refs/heads/main");
  const upstreamMain = () =>
    resolveOid(repoDir(gitApp.reposRoot, LOGIN, "widgets"), "refs/heads/main");

  /** An origin row made without a connect, so nothing is re-attached by it. */
  const originRow = (): string => {
    const made = createOrigin(app.db, app.config.dataDir, {
      userId: alice().id,
      kind: "forgejo",
      apiUrl: fake.apiUrl,
      webUrl: fake.url,
      login: LOGIN,
      token: TOKEN,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value.id;
  };

  const disconnect = async (id: string): Promise<void> => {
    const gone = await api(`/api/v1/user/origins/${id}`, { method: "DELETE" });
    expect(gone.status).toBe(200);
  };

  /** What a refusal must not touch: the git remote and the mirror's columns. */
  async function snapshot(): Promise<{ config: string; row: unknown }> {
    const repo = widgets();
    return {
      config: await readFile(
        join(repoDir(app.reposRoot, "alice", "widgets"), "config"),
        "utf8",
      ),
      row: app.db
        .query(
          `SELECT origin_id, origin_full_name, origin_remote_id, origin_html_url
             FROM repo WHERE id = ?1`,
        )
        .get(repo.id),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reattach-"));
    gitDataDir = await mkdtemp(join(tmpdir(), "forge-reattach-git-"));

    // A second forge is the git host the mirror clones from.
    gitApp = createApp({ dataDir: gitDataDir, port: 0 });
    gitServers = await serve(gitApp);
    await seedAdmin(gitApp, {
      username: LOGIN,
      email: "octo@upstream.test",
      password: TOKEN,
    });
    proveAll(gitApp);
    const auth = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${gitServers.url}/api/v1/repos`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    await commitUpstream("README.md");

    const state = newFakeState("forgejo", LOGIN, TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      defaultBranch: "main",
      cloneUrl: `${gitServers.url}/octo/widgets.git`,
    });
    fake = serveFakeForge(state);
    state.repos[0]!.htmlUrl = `${fake.url}/octo/widgets`;

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    proveAll(app);

    originId = originRow();
    const job = await mirrorAndWait(
      await api(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/widgets" }),
      }),
    );
    expect(job?.stage).toBe("done");
    await disconnect(originId);
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    fake.stop();
    servers.stop();
    gitServers.stop();
    app.close();
    gitApp.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(gitDataDir, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  async function commitUpstream(path: string): Promise<string> {
    const made = await fetch(
      `${gitServers.url}/api/v1/repos/octo/widgets/contents`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) },
        body: JSON.stringify({
          branch: "main",
          message: `upstream: ${path}`,
          files: [{ path, content: `${path}\n` }],
        }),
      },
    );
    expect(made.status).toBeLessThan(300);
    return (await upstreamMain())!;
  }

  test("a mirror is frozen once its origin is disconnected", () => {
    const row = app.db
      .query<{ origin_id: string | null; origin_remote_id: string }, [string]>(
        "SELECT origin_id, origin_remote_id FROM repo WHERE id = ?1",
      )
      .get(widgets().id)!;
    expect(row.origin_id).toBeNull();
    expect(row.origin_remote_id).toBe("41");
  });

  test("a repository renamed at the origin is reattached by its remote id, and syncs", async () => {
    const remote = fake.state.repos[0]!;
    remote.formerNames = ["octo/widgets"];
    remote.fullName = "octo/gears";

    const fresh = originRow();
    const done = await reattachMirror(app, alice(), widgets(), fresh);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.fullName).toBe("octo/gears");
    await syncsSettled();

    const tip = await commitUpstream("moved.txt");
    expect(await mirrorMain()).not.toBe(tip);
    await syncOrigin(app, getOriginById(app.db, fresh)!);
    expect(await mirrorMain()).toBe(tip);
    await disconnect(fresh);
  });

  test("another repository under the same name is not_the_same_repo, and nothing changes", async () => {
    // Deleted at the origin and made again: a new id under the old name.
    fake.state.repos[0]!.id = 99;
    const before = await snapshot();

    const other = originRow();
    const refused = await reattachMirror(app, alice(), widgets(), other);
    expect(refused).toEqual({ ok: false, error: "not_the_same_repo" });
    expect(await snapshot()).toEqual(before);
    expect(before.row).toMatchObject({ origin_id: null, origin_remote_id: "41" });
    fake.state.repos[0]!.id = 41;
    await disconnect(other);
  });

  test("a remote another mirror already holds is already_mirrored, and nothing changes", async () => {
    // The same repository mirrored again, under another local name, through
    // a fresh origin: it holds remote 41 while the frozen one waits.
    const holder = originRow();
    const job = await mirrorAndWait(
      await api(`/api/v1/user/origins/${holder}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/gears", name: "gears" }),
      }),
    );
    expect(job?.stage).toBe("done");
    const before = await snapshot();

    const refused = await reattachMirror(app, alice(), widgets(), holder);
    expect(refused).toEqual({ ok: false, error: "already_mirrored" });
    expect(await snapshot()).toEqual(before);
    expect(before.row).toMatchObject({ origin_id: null });
  });
});
