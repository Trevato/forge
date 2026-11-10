/**
 * An origin connected read-only (#10519): every write-through on a repo
 * mirrored from it answers `origin_read_only` before a request leaves the
 * forge, and a read (sync) still works. The fake remote records every request
 * it receives, so "refused" is proved by "the remote saw no write".
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forkOrigin, contribute } from "../src/actions/contribute.ts";
import { createBranch } from "../src/actions/branches.ts";
import { addCommentThrough, openIssueThrough, setIssueLabelsThrough, setIssueStateThrough } from "../src/actions/issues.ts";
import { mergePull, openPull, submitReview } from "../src/actions/pulls.ts";
import { createSession } from "../src/core/sessions.ts";
import { getOriginById, listOrigins } from "../src/core/origins.ts";
import { setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pushThrough, pushToMirrorTarget } from "../src/origins/push-through.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait, newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-readonly-secret-5d1c";
const PASSWORD = "alice-login-secret";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("an origin connected read-only", () => {
  const dirs: string[] = [];
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let originId = "";

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", PASSWORD));
    return fetch(`${servers.url}${path}`, { ...init, headers });
  };
  const writes = () => fake.state.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");
  const alice = () => getUserByName(app.db, "alice")!;
  const repo = () => getRepo(app.db, "alice", "vault")!;
  const ghost = (n = 1): any => ({ repoId: repo().id, number: n });

  beforeAll(async () => {
    for (const p of ["forge-ro-", "forge-ro-up-"]) dirs.push(await mkdtemp(join(tmpdir(), p)));
    originApp = createApp({ dataDir: dirs[1]!, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, { username: LOGIN, email: "octo@up.test", password: TOKEN });
    const oh = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ name: "vault", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/vault/contents`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ branch: "main", message: "first", files: [{ path: "a.txt", content: "one\n" }] }),
    });
    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({
      id: 9,
      fullName: "octo/vault",
      cloneUrl: `${originServers.url}/octo/vault.git`,
      defaultBranch: "main",
      htmlUrl: `${originServers.url}/octo/vault`,
      push: true,
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    const made = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    if (!made.ok) throw new Error(made.error);
    const connected = (await (
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN, readOnly: true }),
      })
    ).json()) as { id: string };
    originId = connected.id;
    await mirrorAndWait(
      await api(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/vault" }),
      }),
    );
    proveAll(app);
  });

  afterAll(async () => {
    await syncsSettled();
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("the flag is stored, the token is still sealed and never shown", async () => {
    expect(getOriginById(app.db, originId)?.readOnly).toBe(true);
    const row = app.db.query<{ token_enc: string }, [string]>("SELECT token_enc FROM origin WHERE id = ?1").get(originId)!;
    expect(row.token_enc).not.toContain(TOKEN);
    const listed = await (await api("/api/v1/user/origins")).text();
    expect(listed).not.toContain(TOKEN);
  });

  test("a read (sync) still succeeds", async () => {
    const res = await api("/api/v1/repos/alice/vault/sync", { method: "POST" });
    expect(res.status).toBeLessThan(300);
    await syncsSettled();
  });

  test("every write-through refuses and the remote sees no write", async () => {
    const before = writes().length;
    const r = repo();
    const a = alice();
    const refused = (result: { ok: boolean; error?: unknown }) => {
      expect(result.ok).toBe(false);
      expect(result.error).toBe("origin_read_only");
    };

    refused(await openIssueThrough(app, a, r, { title: "hello" }));
    refused(await addCommentThrough(app, a, r, ghost(), "hi"));
    refused(await setIssueStateThrough(app, a, r, ghost(), "closed"));
    refused(await setIssueLabelsThrough(app, a, r, ghost(), ["bug"]));
    refused(await openPull(app, a, r, { title: "t", baseBranch: "main", headBranch: "x" }));
    refused(await submitReview(app, a, r, { ...ghost(), baseBranch: "main", headBranch: "main", crossRepo: false, sealed: false, baseOid: "", headOid: "" } as never, { state: "approved", body: "" }));
    refused(await createBranch(app, a, r, { name: "feature", from: "main" } as never));
    refused(await forkOrigin(app, a, originId, "octo/vault"));
    refused(
      await contribute(app, a, {
        originId,
        fullName: "octo/vault",
        branch: "work",
        files: [{ path: "x.txt", content: "x" }],
      } as never),
    );

    // Merging on a mirror is refused outright, whatever the origin's flag.
    const merged = await mergePull(app, a, r, { ...ghost(), originHeadRepo: null } as never, "merge");
    expect(merged.ok).toBe(false);

    // A push forwarded to the origin.
    const pushed = await pushThrough(app, r, [{ ref: "refs/heads/main", oldOid: "0".repeat(40), newOid: "1".repeat(40) }], {}, a.id);
    expect(pushed.ok).toBe(false);
    if (!pushed.ok) expect(pushed.error.message).toContain("connected read-only");

    // Mirror-out.
    setMirrorTarget(app.db, { repoId: r.id, originId, fullName: "octo/vault", cloneUrl: "http://127.0.0.1:1/x.git", tips: {} });
    const out = await pushToMirrorTarget(app, r);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain("connected read-only");

    expect(writes().length).toBe(before);
  });

  test("merging on a mirror is refused outright, with its own plain answer", async () => {
    const merged = await mergePull(app, alice(), repo(), { ...ghost(), originHeadRepo: null } as never, "merge");
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error).toBe("mirrored");
  });

  test("the REST door answers 409 origin_read_only", async () => {
    const res = await api("/api/v1/repos/alice/vault/issues", {
      method: "POST",
      body: JSON.stringify({ title: "nope" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("origin_read_only");
    expect(body.message).not.toContain("origin_read_only");
  });

  test("an origin connected the ordinary way is not refused as read-only", async () => {
    const state = newFakeState("github", "plain", "plain-secret-77");
    state.repos.push({
      id: 10,
      fullName: "plain/vault2",
      cloneUrl: `${originServers.url}/octo/vault.git`,
      defaultBranch: "main",
      htmlUrl: `${originServers.url}/octo/vault`,
      push: true,
    });
    const plain = serveFakeForge(state);
    try {
      const made = (await (
        await api("/api/v1/user/origins", {
          method: "POST",
          body: JSON.stringify({ host: plain.url, kind: "github", token: "plain-secret-77" }),
        })
      ).json()) as { id: string };
      expect(getOriginById(app.db, made.id)?.readOnly).toBe(false);
      await mirrorAndWait(
        await api(`/api/v1/user/origins/${made.id}/mirror`, {
          method: "POST",
          body: JSON.stringify({ fullName: "plain/vault2" }),
        }),
      );
      proveAll(app);
      const second = getRepo(app.db, "alice", "vault2")!;
      const result = await openIssueThrough(app, alice(), second, { title: "hello" });
      if (!result.ok) expect(result.error).not.toBe("origin_read_only");
      expect(plain.state.requests.some((r) => r.method === "POST")).toBe(true);
    } finally {
      await syncsSettled();
      plain.stop();
    }
  });

  test("a row from before the migration is off: the column defaults to 0", () => {
    const col = app.db
      .query<{ name: string; notnull: number; dflt_value: string }, []>("PRAGMA table_info(origin)")
      .all()
      .find((c) => c.name === "read_only")!;
    expect(col.notnull).toBe(1);
    expect(col.dflt_value).toBe("0");
  });

  test("the web form: readOnly=1 stores the flag, the list shows it, unticked stores none", async () => {
    const cookie = `forge_session=${createSession(app.db, alice().id).token}`;
    const connect = async (login: string, extra: Record<string, string>) => {
      forgetProviders(dirs[0]!);
      const state = newFakeState("forgejo", login, `${login}-tok-123`);
      const f = serveFakeForge(state);
      try {
        const res = await fetch(`${servers.url}/settings/origins/token`, {
          method: "POST",
          headers: { cookie, origin: new URL(servers.url).origin },
          body: new URLSearchParams({ host: f.url, token: `${login}-tok-123`, ...extra }),
          redirect: "manual",
        });
        expect(res.status).toBe(303);
      } finally {
        f.stop();
      }
      return listOrigins(app.db, alice().id).find((o) => o.login === login)!;
    };
    const ticked = await connect("webro", { readOnly: "1" });
    expect(ticked.readOnly).toBe(true);
    const unticked = await connect("webrw", {});
    expect(unticked.readOnly).toBe(false);
    const page = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie } })).text();
    expect(page).toContain("read-only: nothing is written back");
  });
});
