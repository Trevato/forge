/** createBranch / deleteBranch: a mirror's ref moves only after its origin took the push; a native repo's moves at once; a reader is refused. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, deleteBranch } from "../src/actions/branches.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { ForgeEvent } from "../src/core/events.ts";
import { createOrigin, linkRepoToOrigin, rememberOriginRepo } from "../src/core/origins.ts";
import { createRepo, getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { advertiseRefs, isGitService, serviceRpc } from "../src/git/smart-http.ts";
import { runGitCapture } from "../src/git/env.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const LOGIN = "octo";
const TOKEN = "origin-secret-token-7511";
const HEADER = `Basic ${Buffer.from(`${LOGIN}:${TOKEN}`).toString("base64")}`;

let dataDir: string;
let app: App;
let ada: User;
let bob: User;
let native: Repo;
let mirror: Repo;
let server: ReturnType<typeof Bun.serve>;
let originDir: string;
let reject = "";
const events: ForgeEvent[] = [];

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const tip = (repo: Repo, branch: string) =>
  resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), `refs/heads/${branch}`);
const originTip = (branch: string) => resolveOid(originDir, `refs/heads/${branch}`);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-branches-action-"));
  app = createApp({ dataDir, port: 0 });
  app.bus.subscribe((e) => events.push(e));
  const make = (username: string) =>
    createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
  ada = must(await make("ada"));
  bob = must(await make("bob"));

  // The origin: a local bare repository behind the forge's own smart-HTTP plumbing.
  originDir = join(dataDir, "origin.git");
  await runGitCapture(["init", "-q", "--bare", "-b", "main", originDir], { cwd: dataDir });
  const hook = join(originDir, "hooks", "pre-receive");
  await Bun.write(hook, `#!/bin/sh\nif [ -n "$FAKE_REJECT" ]; then echo "$FAKE_REJECT" >&2; exit 1; fi\nexit 0\n`);
  await chmod(hook, 0o755);
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const match = /^\/octo\/gears\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (!match) return new Response("not found", { status: 404 });
      if (request.headers.get("authorization") !== HEADER) return new Response("no", { status: 401, headers: { "www-authenticate": "Basic" } });
      if (match[1] === "info/refs") {
        const service = url.searchParams.get("service");
        return isGitService(service) ? advertiseRefs(originDir, service, request) : new Response("smart only", { status: 400 });
      }
      if (match[1] === "git-upload-pack") return serviceRpc(originDir, "git-upload-pack", request);
      return serviceRpc(originDir, "git-receive-pack", request, { env: { FAKE_REJECT: reject } });
    },
  });
  const base = `http://localhost:${server.port}`;

  native = must(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "plain", visibility: "private" }));
  mirror = must(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "gears", visibility: "private" }));
  for (const repo of [native, mirror])
    must(await commitToBranch(app, ada, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));

  const origin = must(
    createOrigin(app.db, dataDir, { userId: ada.id, kind: "forgejo", apiUrl: `${base}/api/v1`, webUrl: base, login: LOGIN, token: TOKEN }),
  );
  rememberOriginRepo(app.db, origin.id, {
    remoteId: "1", fullName: "octo/gears", owner: "octo", name: "gears", description: "", private: true, fork: false,
    parent: null, defaultBranch: "main", cloneUrl: `${base}/octo/gears.git`, sshUrl: "", htmlUrl: `${base}/octo/gears`,
    pushedAt: null, permissions: { push: true, admin: false },
    openIssues: 0, openPulls: 0, openIssuesIncludesPulls: false, sizeKb: 0,
  });
  linkRepoToOrigin(app.db, mirror.id, { originId: origin.id, fullName: "octo/gears", remoteId: "1", htmlUrl: `${base}/octo/gears` });
  mirror = getRepo(app.db, "ada", "gears")!;
}, 30_000);

afterAll(async () => {
  server?.stop(true);
  app?.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("a native repository", () => {
  test("a branch is created and deleted locally and each is announced", async () => {
    const made = must(await createBranch(app, ada, native, { name: "feat" }));
    expect(await tip(native, "feat")).toBe(made.oid);
    expect(events.some((e) => e.kind === "branch.created" && e.repoId === native.id)).toBe(true);

    must(await deleteBranch(app, ada, native, "feat"));
    expect(await tip(native, "feat")).toBeUndefined();
    expect(events.some((e) => e.kind === "branch.deleted" && e.repoId === native.id)).toBe(true);
  });

  test("the default branch is never deleted", async () => {
    const r = await deleteBranch(app, ada, native, native.defaultBranch);
    expect(r).toEqual({ ok: false, error: "default_branch" });
  });
});

describe("a reader", () => {
  test("of a public repository is told forbidden, and nothing moves", async () => {
    const open = must(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "open", visibility: "public" }));
    must(await commitToBranch(app, ada, open, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
    expect(await createBranch(app, bob, open, { name: "nope" })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteBranch(app, bob, open, "nope")).toEqual({ ok: false, error: "forbidden" });
    expect(await tip(open, "nope")).toBeUndefined();
  });

  test("is refused with not_found, and nothing moves", async () => {
    expect(await createBranch(app, bob, native, { name: "nope" })).toEqual({ ok: false, error: "not_found" });
    expect(await createBranch(app, undefined, native, { name: "nope" })).toEqual({ ok: false, error: "not_found" });
    expect(await deleteBranch(app, bob, native, "main")).toEqual({ ok: false, error: "not_found" });
    expect(await tip(native, "nope")).toBeUndefined();
  });
});

describe("a mirrored repository", () => {
  test("a refusing origin leaves the local ref where it was, and the refusal is a refusal, not a failure", async () => {
    reject = "branch creation is closed here";
    const before = events.length;
    const r = await createBranch(app, ada, mirror, { name: "feat" });
    expect(r).toEqual({ ok: false, error: "origin_refused" });
    expect(await tip(mirror, "feat")).toBeUndefined();
    expect(await originTip("feat")).toBeUndefined();
    expect(events.length).toBe(before);
  });

  test("an accepting origin takes the ref first, then the local ref moves and it is announced", async () => {
    reject = "";
    const made = must(await createBranch(app, ada, mirror, { name: "feat" }));
    expect(await originTip("feat")).toBe(made.oid);
    expect(await tip(mirror, "feat")).toBe(made.oid);
    expect(events.some((e) => e.kind === "branch.created" && e.repoId === mirror.id)).toBe(true);
  });

  test("a branch that exists locally is not created again", async () => {
    expect(await createBranch(app, ada, mirror, { name: "feat" })).toEqual({ ok: false, error: "exists" });
  });

  test("a branch only the origin has is refused by its lease, and no local ref appears", async () => {
    const dir = repoDir(app.reposRoot, mirror.ownerName, mirror.name);
    // A commit the origin holds under that name and the mirror does not: same
    // tree, different message, so the oid differs from the mirror's start point.
    const other = await runGitCapture(["commit-tree", "main^{tree}", "-m", "theirs"], {
      cwd: dir,
      env: { GIT_AUTHOR_NAME: "o", GIT_AUTHOR_EMAIL: "o@o", GIT_COMMITTER_NAME: "o", GIT_COMMITTER_EMAIL: "o@o" },
    });
    const pushed = await runGitCapture(["push", originDir, `${other.stdout.trim()}:refs/heads/theirs`], { cwd: dir });
    expect(pushed.code).toBe(0);
    expect(await createBranch(app, ada, mirror, { name: "theirs" })).toEqual({ ok: false, error: "origin_refused" });
    expect(await tip(mirror, "theirs")).toBeUndefined();
  });

  test("a refusing origin keeps the local branch on delete", async () => {
    reject = "deletes need review";
    const before = await tip(mirror, "feat");
    const r = await deleteBranch(app, ada, mirror, "feat");
    expect(r).toEqual({ ok: false, error: "origin_refused" });
    expect(await tip(mirror, "feat")).toBe(before);
    expect(await originTip("feat")).toBe(before);
  });

  test("an accepting origin drops the ref, then the local one goes and it is announced", async () => {
    reject = "";
    must(await deleteBranch(app, ada, mirror, "feat"));
    expect(await originTip("feat")).toBeUndefined();
    expect(await tip(mirror, "feat")).toBeUndefined();
    expect(events.some((e) => e.kind === "branch.deleted" && e.repoId === mirror.id)).toBe(true);
  });

  test("only the origin's owner pushes with its credential", async () => {
    const other = must(await createUser(app.db, { origin: "seed", trusted: true, username: "cy", email: "cy@forge.local", password: "a-good-passphrase" }));
    expect(await createBranch(app, other, mirror, { name: "x" })).toEqual({ ok: false, error: "not_found" });
    expect(await tip(mirror, "x")).toBeUndefined();
  });
});
