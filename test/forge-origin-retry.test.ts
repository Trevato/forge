import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getOriginFor, listOrigins } from "../src/core/origins.ts";
import { createToken } from "../src/core/tokens.ts";
import type { User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstFetchRetry, mirrorRepo } from "../src/origins/mirror.ts";
import { connectOrigin } from "../src/actions/origins.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

/**
 * The compatibility lab's finding (`docs/features/forge-origin-compat.md`): the
 * origin dies while a repository's first fetch runs. The job fails in words
 * and the repository is there with nothing in it. Asking again must finish
 * the job, not answer "already mirrored" about an empty repository.
 */

setDefaultTimeout(60_000);

let mine: App;
let friend: App;
let friendServers: Servers;
let gate: ReturnType<typeof Bun.serve>;
let alice: User;
let gitDown = false;
const dirs: string[] = [];

beforeAll(async () => {
  const make = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "forge-retry-"));
    dirs.push(dir);
    return dir;
  };
  friend = createApp({ dataDir: await make(), port: 0 });
  friendServers = await serve(friend);
  const bob = await seedAdmin(friend, { username: "bob", email: "bob@friend.test", password: "bob-login-secret" });
  if (!bob.ok) throw new Error(bob.error);
  const made = await createRepo(friend, bob.value, { name: "widgets", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const done = await commitToBranch(friend, bob.value, made.value, {
    branch: "main",
    message: "one",
    files: [{ path: "a.txt", content: "a\n" }],
  });
  if (!done.ok) throw new Error(String(done.error));
  proveAll(friend);

  // The origin's API answers while its git does not: what a dying forge looks like part way through.
  gate = Bun.serve({
    port: 0,
    idleTimeout: 60,
    fetch(request) {
      const url = new URL(request.url);
      if (gitDown && /\.git\//.test(url.pathname)) return new Response("gone", { status: 503 });
      return fetch(`${friendServers.url}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: request.body }),
        redirect: "manual",
        decompress: false,
      } as RequestInit);
    },
  });

  mine = createApp({ dataDir: await make(), port: 0 });
  const me = await seedAdmin(mine, { username: "alice", email: "alice@forge.test", password: "alice-login-secret" });
  if (!me.ok) throw new Error(me.error);
  alice = me.value;
  proveAll(mine);
  const token = createToken(friend.db, bob.value.id, "ro", "ro").token;
  const connected = await connectOrigin(mine, alice, { host: `http://127.0.0.1:${gate.port}`, token });
  if (!connected.ok) throw new Error(String(connected.error));
});

afterAll(async () => {
  await syncsSettled();
  gate.stop(true);
  friendServers.stop();
  mine.close();
  friend.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

test("a bring whose fetch failed is finished by asking again; a whole one is still refused", async () => {
  const origin = getOriginFor(mine.db, alice.id, listOrigins(mine.db, alice.id)[0]!.id)!;
  const waits = firstFetchRetry.ms;
  firstFetchRetry.ms = [];
  try {
    gitDown = true;
    const first = await mirrorRepo(mine, alice, origin, "bob/widgets");
    expect(first.ok && first.value.error !== "").toBe(true);

    gitDown = false;
    const again = await mirrorRepo(mine, alice, origin, "bob/widgets");
    expect(again.ok && again.value.error).toBe("");
    const theirs = await resolveOid(repoDir(friend.reposRoot, "bob", "widgets"), "refs/heads/main");
    expect(theirs).toBeDefined();
    expect(await resolveOid(repoDir(mine.reposRoot, "alice", "widgets"), "refs/heads/main")).toBe(theirs);

    const third = await mirrorRepo(mine, alice, origin, "bob/widgets");
    expect(third.ok ? "brought" : third.error).toBe("already_mirrored");
  } finally {
    firstFetchRetry.ms = waits;
  }
});

test("a forge's labels come across with its work", async () => {
  expect(await seedLabel()).toBe(true);
  const origin = getOriginFor(mine.db, alice.id, listOrigins(mine.db, alice.id)[0]!.id)!;
  const { providerForOrigin } = await import("../src/origins/credential.ts");
  const provider = providerForOrigin(mine, origin);
  if (!provider.ok) throw new Error("no provider");
  const listed = await provider.value.listLabels("bob/widgets");
  expect(listed.ok && listed.value.map((l) => [l.name, l.color])).toEqual([["bug", "ff0000"]]);
});

async function seedLabel(): Promise<boolean> {
  const { createLabel } = await import("../src/core/issues.ts");
  const { getRepo } = await import("../src/core/repos.ts");
  const repo = getRepo(friend.db, "bob", "widgets");
  if (repo === undefined) return false;
  createLabel(friend.db, repo.id, "bug", "ff0000");
  return true;
}
