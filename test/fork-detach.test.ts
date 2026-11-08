/**
 * #7452: a fork whose parent is archived shows one quiet line, never
 * "following <parent> · N ahead", and neither does the parent's forks page;
 * and a repository admin detaches a fork from its parent — planned first,
 * repacked off the request path, then the parent forgotten.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { detachFromParent, detachJob } from "../src/actions/detach.ts";
import { updateRepoSettings } from "../src/actions/repos.ts";
import { createRepo, forkRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { listEvents } from "../src/core/events.ts";
import type { User } from "../src/core/users.ts";
import { hasAlternates, repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let owner: User;
let forker: User;
let n = 0;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out: out.trim(), code };
};

const commit = async (dir: string, subject: string) =>
  ok(
    await commitFiles(dir, {
      branch: "main",
      message: subject,
      files: [{ path: `${subject}.txt`, content: subject }],
      author: { name: "T", email: "t@forge.test" },
    }),
  );

/** A public parent of two commits, and a fork two commits ahead of it. */
async function family(): Promise<{ parent: Repo; fork: Repo; forkDir: string }> {
  n += 1;
  const parent = ok(
    await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: `up${n}`, visibility: "public" }),
  );
  const parentDir = repoDir(app.reposRoot, parent.ownerName, parent.name);
  await commit(parentDir, "one");
  await commit(parentDir, "two");
  const fork = ok(await forkRepo(app.db, app.reposRoot, parent, forker.id, `down${n}`));
  const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  await commit(forkDir, "mine");
  await commit(forkDir, "also-mine");
  return { parent, fork, forkDir };
}

const page = async (path: string) => (await fetch(`${servers.url}${path}`)).text();

async function mcp(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "detach", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fork-detach-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const user = async (username: string) =>
    ok(await signUp(app, { username, email: `${username}@forge.test`, password: "a-long-passphrase" }));
  owner = await user("upstreamer");
  forker = await user("forker");
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("an archived parent", () => {
  test("hides the following card and the ahead badge on the fork, its forks page and its lineage", async () => {
    const { parent, fork } = await family();
    const forkPath = `/${fork.ownerName}/${fork.name}`;
    const parentForks = `/${parent.ownerName}/${parent.name}/forks`;

    // Awake, the fork says how far it is ahead.
    const before = await page(forkPath);
    expect(before).toContain('id="following"');
    expect(before).toContain("2 ahead");
    expect(await page(parentForks)).toContain("2 ahead");

    ok(await updateRepoSettings(app, owner, parent, { archived: true }));

    const after = await page(forkPath);
    expect(after).not.toContain('id="following"');
    expect(after).not.toContain("2 ahead");
    expect(after).toContain("data-archived-parent");
    expect(after).toMatch(/forked from\s*<a href="\/upstreamer\/up\d+">upstreamer\/up\d+<\/a>\s*\(archived\)/);
    // Its forks page counts nothing against it, and names the fork still.
    const forks = await page(parentForks);
    expect(forks).not.toContain("2 ahead");
    expect(forks).not.toContain("nothing new");
    expect(forks).toContain(`${fork.ownerName}/${fork.name}`);
    // The family tree seen from the fork carries no badge against it.
    const lineage = await page(`${forkPath}/forks`);
    expect(lineage).not.toContain("2 ahead");
  }, 30_000);
});

describe("detach from parent", () => {
  test("is planned first, then leaves no alternates, a sound repository and no parent", async () => {
    const { parent, fork, forkDir } = await family();
    expect(await hasAlternates(forkDir)).toBe(true);
    const token = createToken(app.db, forker.id, "admin", "admin").token;

    const plan = await mcp(token, { repo: `${fork.ownerName}/${fork.name}` });
    expect(plan.value).toMatchObject({
      dryRun: true,
      borrows: true,
      parent: `${parent.ownerName}/${parent.name}`,
    });
    expect(getRepoById(app.db, fork.id)!.forkParentId).toBe(parent.id);
    expect(detachJob(fork.id)).toBeUndefined();

    const started = await mcp(token, { repo: `${fork.ownerName}/${fork.name}`, dryRun: false });
    expect(started.value).toMatchObject({ dryRun: false });
    await detachJob(fork.id)?.done;

    expect(await hasAlternates(forkDir)).toBe(false);
    expect((await git(forkDir, "fsck", "--full")).code).toBe(0);
    expect((await git(forkDir, "log", "--format=%s", "main")).out.split("\n")).toEqual([
      "also-mine",
      "mine",
      "two",
      "one",
    ]);
    expect(getRepoById(app.db, fork.id)!.forkParentId).toBeNull();
    expect(detachJob(fork.id)).toBeUndefined();
    expect(listEvents(app.db, { repoId: fork.id, kind: "repo.detached", limit: 5 })).toHaveLength(1);
    // The parent is not its parent any more, on the page or to the tool.
    expect(await page(`/${fork.ownerName}/${fork.name}`)).not.toContain('id="following"');
    expect((await mcp(token, { repo: `${fork.ownerName}/${fork.name}` })).value).toMatchObject({ parent: null });
  }, 30_000);

  test("is an admin's: a reader is refused and nothing changes", async () => {
    const { fork, forkDir } = await family();
    const asked = await detachFromParent(app, owner, fork, false);
    expect(asked).toEqual({ ok: false, error: "not_found" });
    expect(await hasAlternates(forkDir)).toBe(true);
    const small = createToken(app.db, forker.id, "rw", "rw").token;
    expect((await mcp(small, { repo: `${fork.ownerName}/${fork.name}`, dryRun: false })).error).toContain(
      "forbidden",
    );
    expect(getRepoById(app.db, fork.id)!.forkParentId).not.toBeNull();
  }, 30_000);

  test("Settings › Danger zone shows the card, and its same-origin POST detaches", async () => {
    const { fork, forkDir } = await family();
    const base = `/${fork.ownerName}/${fork.name}`;
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "forker", password: "a-long-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    // Two taps from the fork once its parent is archived: the quiet line, then the card.
    ok(await updateRepoSettings(app, owner, getRepoById(app.db, fork.forkParentId!)!, { archived: true }));
    const home = await (await fetch(`${servers.url}${base}`, { headers: { cookie } })).text();
    expect(home).toContain(`href="${base}/settings/danger#detach"`);
    const danger = await (await fetch(`${servers.url}${base}/settings/danger`, { headers: { cookie } })).text();
    expect(danger).toContain(`href="/-/confirm?to=${encodeURIComponent(`${base}/settings/detach`)}"`);
    expect(danger).toContain("Detach from parent");

    const post = (origin: string) =>
      fetch(`${servers.url}${base}/settings/detach`, {
        method: "POST",
        headers: { cookie, origin },
        body: new URLSearchParams({}),
        redirect: "manual",
      });
    const foreign = await post("https://evil.example");
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(detachJob(fork.id)).toBeUndefined();
    const res = await post(servers.url);
    expect(res.status).toBe(303);
    await detachJob(fork.id)?.done;
    expect(await hasAlternates(forkDir)).toBe(false);
    expect(getRepoById(app.db, fork.id)!.forkParentId).toBeNull();
  }, 30_000);

  test("never names a parent its admin may not read: not on the card, in the plan or in the event", async () => {
    n += 1;
    const secret = ok(
      await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: `hidden${n}`, visibility: "private" }),
    );
    await commit(repoDir(app.reposRoot, secret.ownerName, secret.name), "one");
    // Forked while it could be read; the forker cannot read it now.
    const fork = ok(await forkRepo(app.db, app.reposRoot, secret, forker.id, `kept${n}`));
    const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
    const name = `${secret.ownerName}/${secret.name}`;
    const { detachCard } = await import("../src/web/pages/detach.ts");
    const card = String(detachCard(app.db, fork, forker));
    expect(card).toContain("its parent");
    expect(card).not.toContain(secret.name);

    const token = createToken(app.db, forker.id, "admin", "admin").token;
    const plan = await mcp(token, { repo: `${fork.ownerName}/${fork.name}` });
    expect(plan.value).toMatchObject({ parent: null, borrows: true, dryRun: true });
    expect(JSON.stringify(plan.value)).not.toContain(secret.name);

    await mcp(token, { repo: `${fork.ownerName}/${fork.name}`, dryRun: false });
    await detachJob(fork.id)?.done;
    expect(await hasAlternates(forkDir)).toBe(false);
    const events = listEvents(app.db, { repoId: fork.id, kind: "repo.detached", limit: 5 });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.payload)).not.toContain(name);
    expect(events[0]!.payload).toEqual({ parentId: secret.id });
  }, 30_000);
});
