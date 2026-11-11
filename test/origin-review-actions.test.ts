/**
 * Submitting a review with line comments on a mirrored pull (#11479): when
 * the origin carries the lines inside the review they are not also posted
 * here, and a sync is asked for; when it refuses them they are posted here,
 * once, and the reviewer is told.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { submitReview } from "../src/actions/pulls.ts";
import { getCursor } from "../src/core/origins.ts";
import { listPulls } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait, newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();
setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-review-lines-secret-3a9e";
const PASSWORD = "alice-login-secret";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("a review's lines on a mirrored pull", () => {
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
  const repo = () => getRepo(app.db, "alice", "vault")!;
  const pull = () => listPulls(app.db, repo().id)[0]!;
  const posts = () => fake.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/pulls/1/reviews"));
  const localLines = () =>
    app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND path IS NOT NULL").get(pull().id)!.n;
  const nextSync = () => getCursor(app.db, originId, "next_sync_at");
  const lines = [{ path: "b.txt", line: 1, side: "new" as const, body: "why this?" }];

  beforeAll(async () => {
    for (const p of ["forge-rl-", "forge-rl-up-"]) dirs.push(await mkdtemp(join(tmpdir(), p)));
    originApp = createApp({ dataDir: dirs[1]!, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, { username: LOGIN, email: "octo@up.test", password: TOKEN });
    const oh = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${originServers.url}/api/v1/repos`, { method: "POST", headers: oh, body: JSON.stringify({ name: "vault", visibility: "public" }) });
    await fetch(`${originServers.url}/api/v1/repos/octo/vault/contents`, {
      method: "POST", headers: oh,
      body: JSON.stringify({ branch: "main", message: "first", files: [{ path: "a.txt", content: "one\n" }] }),
    });
    const made = await fetch(`${originServers.url}/api/v1/repos/octo/vault/contents`, {
      method: "POST", headers: oh,
      body: JSON.stringify({ branch: "feature", message: "more", files: [{ path: "b.txt", content: "two\n" }] }),
    });
    const { commitOid } = (await made.json()) as { commitOid: string };

    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({ id: 9, fullName: "octo/vault", cloneUrl: `${originServers.url}/octo/vault.git`, defaultBranch: "main", htmlUrl: `${originServers.url}/octo/vault`, push: true });
    state.issues.set("octo/vault", [
      { id: 5, number: 1, title: "more", body: "", state: "open", user: LOGIN, labels: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pull: { base: "main", head: "feature", headSha: commitOid } },
    ] as never);
    fake = serveFakeForge(state);

    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    const admin = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    if (!admin.ok) throw new Error(admin.error);
    const connected = (await (await api("/api/v1/user/origins", { method: "POST", body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN }) })).json()) as { id: string };
    originId = connected.id;
    await mirrorAndWait(await api(`/api/v1/user/origins/${originId}/mirror`, { method: "POST", body: JSON.stringify({ fullName: "octo/vault" }) }));
    await syncsSettled();
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

  const send = () =>
    submitReview(app, getUserByName(app.db, "alice")!, repo(), pull(), { state: "changes_requested", body: "see lines", comments: lines });

  test("carried by the origin: one request, no local duplicate, a sync asked for", async () => {
    expect(pull().number).toBe(1);
    app.db.query("DELETE FROM origin_cursor WHERE origin_id = ?1 AND key = 'next_sync_at'").run(originId);
    const sent = await send();
    expect(sent.ok).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(localLines()).toBe(0);
    expect(nextSync()).toBe(new Date(0).toISOString());
    if (sent.ok) expect(sent.value.note).toBeUndefined();
  });

  test("refused by the origin: the lines are posted here once, and the reviewer is told", async () => {
    fake.state.refuseReviewComments = true;
    const before = posts().length;
    const sent = await send();
    expect(sent.ok).toBe(true);
    expect(posts().length - before).toBe(2);
    expect(localLines()).toBe(1);
    if (sent.ok) expect(sent.value.note).toContain("kept here");
  });
});
