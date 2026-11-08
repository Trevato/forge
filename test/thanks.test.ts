/**
 * The thank-you note (#9013): a pull brought from the mirror lands, and its
 * author is thanked by name on the pull and on the mirror pull, with the
 * landing commit linked and what changed on the way; once per landing,
 * never for a crew pull or one made here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landSlice } from "../src/actions/pull_slices.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { createOrigin } from "../src/core/origins.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { recordPullSource } from "../src/core/trusted_sources.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { proveAll } from "./helpers/verified.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { approveGuest } from "../src/origins/guest.ts";
import { bringMirrorPulls, type FetchHead } from "../src/origins/mirror-pulls.ts";
import { ForgejoProvider } from "../src/origins/providers/forgejo.ts";
import { thankAuthor, thanksNote, whomToThank } from "../src/origins/thanks.ts";
import { staticCredential } from "../src/origins/types.ts";
import { newFakeState, serveFakeForge, type FakeForge, type FakeState } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "tok-thanks-1234";
const OID = "a".repeat(40);

describe("the note's words", () => {
  test("names the author, links the landing commit and lists what changed", () => {
    const note = thanksNote({
      name: "jay@other.forge",
      number: 7,
      mergeOid: OID,
      commitUrl: `https://forge.test/alice/app/commit/${OID}`,
      strategy: "merge",
      baseBranch: "main",
      commits: 3,
      authors: ["Jay Moran"],
      files: 2,
      slices: ["b".repeat(40)],
      resolved: [{ oid: "c".repeat(40), subject: "Merge `main` into fix" }],
    });
    expect(note).toStartWith("Thank you, jay@other.forge: pull #7 landed in");
    expect(note).toContain(`[\`aaaaaaaaaaaa\`](https://forge.test/alice/app/commit/${OID})`);
    expect(note).toContain("3 commits by Jay Moran touched 2 files");
    expect(note).toContain("landed in 2 slices: `bbbbbbbbbbbb`");
    expect(note).toContain("conflicts resolved: 1 merge of main into your branch (`cccccccccccc` Merge  main  into fix)");
  });

  test("a squash that changed nothing else says so", () => {
    const note = thanksNote({
      name: "@bob",
      number: 2,
      mergeOid: OID,
      commitUrl: null,
      strategy: "squash",
      baseBranch: "main",
      commits: 1,
      authors: [],
      files: 1,
      slices: [],
      resolved: [],
    });
    expect(note).toContain("landed in `aaaaaaaaaaaa`.");
    expect(note).toContain("Nothing changed on the way");
  });
});

describe("a landed mirror pull thanks its author once", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let fake: FakeForge;
  let state: FakeState;

  const fetchHead: FetchHead = async (a, r, _t, _p, number, ref) => {
    const made = await commitToBranch(a, alice, r, {
      branch: ref.replace(/^refs\/heads\//, ""),
      message: `Mirror pull ${number}`,
      files: [{ path: `m${number}.md`, content: "from the mirror\n" }],
    });
    return made.ok ? resolveOid(repoDir(a.reposRoot, r.ownerName, r.name), ref) : undefined;
  };
  const provider = () =>
    new ForgejoProvider(staticCredential({ kind: "forgejo", apiUrl: fake.apiUrl, webUrl: fake.url, token: TOKEN }));
  const notesOn = (number: number): string[] =>
    app.db
      .query<{ body: string }, [string, number]>(
        "SELECT body FROM comment WHERE issue_id = (SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2) AND body LIKE 'Thank you, %'",
      )
      .all(repo.id, number)
      .map((r) => r.body);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-thanks-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.test" });
    state = newFakeState("forgejo", "trevato", TOKEN);
    state.repos.push({ id: 1, fullName: "trevato-apps/forge", cloneUrl: "http://127.0.0.1/none.git", admin: true });
    fake = serveFakeForge(state);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "forge", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "forge\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const origin = createOrigin(app.db, dataDir, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: fake.apiUrl,
      webUrl: fake.url,
      login: "trevato",
      token: TOKEN,
    });
    if (!origin.ok) throw new Error(origin.error);
    setMirrorTarget(app.db, {
      repoId: repo.id,
      originId: origin.value.id,
      fullName: "trevato-apps/forge",
      cloneUrl: `${fake.url}/trevato-apps/forge.git`,
      tips: {},
    });
  }, 60_000);

  afterAll(async () => {
    fake.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("on the pull and on the mirror pull, naming the author and the commit; never twice", async () => {
    state.issues.set("trevato-apps/forge", [
      {
        id: 501,
        number: 1,
        title: "Fix 1",
        body: "It was broken.",
        user: "tdobbertin-espo",
        pull: { base: "main", head: "fix-1", headRepo: "tdobbertin-espo/forge", headSha: "1".padStart(40, "a") },
      },
    ]);
    const report = await bringMirrorPulls(app, repo, { provider: provider(), fetchHead });
    const pull = getPull(app.db, repo.id, report.opened[0]!)!;
    expect(approveGuest(app.db, repo, pull, alice).ok).toBe(true);
    const merged = await mergePull(app, alice, repo, pull, "merge");
    if (!merged.ok) throw new Error(String(merged.error));
    const oid = merged.value.mergeOid;

    const here = notesOn(pull.number);
    expect(here).toHaveLength(1);
    expect(here[0]).toStartWith(`Thank you, tdobbertin-espo: pull #${pull.number} landed in`);
    expect(here[0]).toContain(`https://forge.test/alice/forge/commit/${oid}`);
    expect(here[0]).toContain("1 commit by alice touched 1 file");

    // The mirror's copy goes out after the merge answers.
    const onMirror = () => (state.comments.get("trevato-apps/forge") ?? []).filter((c) => c.body.startsWith("Thank you"));
    for (let i = 0; i < 50 && onMirror().length === 0; i++) await Bun.sleep(20);
    expect(onMirror()).toHaveLength(1);
    expect(onMirror()[0]!.issueNumber).toBe(1);
    expect(onMirror()[0]!.body).toBe(here[0]!);

    // A second call for the same landing writes nothing.
    const again = await thankAuthor(app, repo, getPull(app.db, repo.id, pull.number)!, {
      mergeOid: oid,
      strategy: "merge",
      by: alice.id,
    });
    expect(again).toBeUndefined();
    expect(notesOn(pull.number)).toHaveLength(1);
    expect(onMirror()).toHaveLength(1);
  });

  test("a pull made here, or by the crew, is not thanked", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "topic",
      message: "inside",
      files: [{ path: "in.md", content: "in\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, { title: "inside", body: "", baseBranch: "main", headBranch: "topic" });
    if (!opened.ok) throw new Error(String(opened.error));
    expect(whomToThank(app, opened.value)).toBeUndefined();
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    expect(merged.ok).toBe(true);
    expect(notesOn(opened.value.number)).toHaveLength(0);

    // A crew pull brought from the mirror still has an agent for an author here.
    const mirrored = getPull(app.db, repo.id, 1)!;
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(mirrored.authorId);
    expect(whomToThank(app, mirrored)).toBeUndefined();
    app.db.query("UPDATE user SET is_agent = 0 WHERE id = ?1").run(mirrored.authorId);
  });

  test("a note someone else posts naming the landing does not stand in for the real one", async () => {
    const mallory = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "mallory",
      email: "mallory@forge.test",
      password: "a-good-passphrase",
    });
    if (!mallory.ok) throw new Error(mallory.error);
    const pull = getPull(app.db, repo.id, 1)!;
    const oid = (await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), "refs/heads/main"))!;
    app.db.query("DELETE FROM comment WHERE issue_id = ?1 AND body LIKE 'Thank you, %'").run(pull.id);
    app.db
      .query("INSERT INTO comment (id, issue_id, author_id, body) VALUES ('forged', ?1, ?2, ?3)")
      .run(pull.id, mallory.value.id, `Thank you, nobody: landed in ${oid.slice(0, 12)}`);
    const note = await thankAuthor(app, repo, pull, { mergeOid: oid, strategy: "merge", by: alice.id });
    expect(note).toStartWith("Thank you, tdobbertin-espo");
  });

  test("work from another forge is thanked as account@host", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "from-afar",
      message: "afar",
      files: [{ path: "afar.md", content: "afar\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, { title: "afar", body: "", baseBranch: "main", headBranch: "from-afar" });
    if (!opened.ok) throw new Error(String(opened.error));
    recordPullSource(app.db, { pullId: opened.value.id, host: "other.forge", account: "jay", via: [] });
    expect(whomToThank(app, opened.value)).toEqual({ name: "jay@other.forge", originUrl: null });
  });

});

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Bob Kept",
  GIT_AUTHOR_EMAIL: "bob@f.dev",
  GIT_COMMITTER_NAME: "Bob Kept",
  GIT_COMMITTER_EMAIL: "bob@f.dev",
});

describe("a kept fork's note lists what changed on the way", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice = "";
  let bob = "";

  async function git(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    const [out, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${e}`);
    return out.trim();
  }
  const call = (path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const authed = (user: string, token: string) => base.replace("http://", `http://${user}:${token}@`);
  async function signup(username: string): Promise<string> {
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "thanks-pass-123" }),
      redirect: "manual",
    });
    return tokenFor(app, username, "admin", "k");
  }
  async function commit(dir: string, file: string): Promise<string> {
    await Bun.write(join(dir, file), `${file}\n`);
    await git(["add", "."], dir);
    await git(["commit", "-m", `add ${file}`], dir);
    return git(["rev-parse", "HEAD"], dir);
  }
  async function open(head: string): Promise<number> {
    const r = await call("/api/v1/repos/alice/app/pulls", bob, { title: head, base: "main", head, headRepo: "bob/app" });
    expect(r.status).toBe(201);
    return ((await r.json()) as { number: number }).number;
  }
  const notesOn = (number: number): string[] =>
    app.db
      .query<{ body: string }, [number]>(
        "SELECT body FROM comment WHERE issue_id = (SELECT i.id FROM issue i JOIN repo r ON r.id = i.repo_id WHERE r.name = 'app' AND i.number = ?1 AND i.kind = 'pull' AND r.owner_id = (SELECT id FROM user WHERE username = 'alice')) AND body LIKE 'Thank you, %'",
      )
      .all(number)
      .map((r) => r.body);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-thanks-kf-"));
    work = await mkdtemp(join(tmpdir(), "forge-thanks-kf-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await signup("alice");
    bob = await signup("bob");
    proveAll(app);
    promote(app.db);
    await call("/api/v1/repos", alice, { name: "app", visibility: "public" });
    await git(["clone", `${authed("alice", alice)}/alice/app.git`, "a"], work);
    await commit(join(work, "a"), "seed.txt");
    await git(["push", "origin", "main"], join(work, "a"));
    await call("/api/v1/repos/alice/app/forks", bob, {});
    await git(["clone", `${authed("bob", bob)}/bob/app.git`, "b"], work);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("a branch that merged main in: thanked as @bob, the merge named as conflicts resolved", async () => {
    const a = join(work, "a");
    const b = join(work, "b");
    await git(["checkout", "-b", "fix"], b);
    await commit(b, "fix.txt");
    await commit(a, "moved.txt");
    await git(["push", "origin", "main"], a);
    await git(["fetch", `${authed("alice", alice)}/alice/app.git`, "main"], b);
    await git(["merge", "--no-edit", "-m", "Merge main into fix", "FETCH_HEAD"], b);
    const resolved = await git(["rev-parse", "HEAD"], b);
    await git(["push", "origin", "fix"], b);
    const number = await open("fix");
    const merged = await call(`/api/v1/repos/alice/app/pulls/${number}/merge`, alice, { strategy: "merge" });
    expect(merged.status).toBe(200);
    const notes = notesOn(number);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toStartWith(`Thank you, @bob: pull #${number} landed in`);
    expect(notes[0]).toContain(`conflicts resolved: 1 merge of main into your branch (\`${resolved.slice(0, 12)}\` Merge main into fix)`);
  });

  test("a pull landed in slices: the note lists the slice before the last", async () => {
    const b = join(work, "b");
    await git(["fetch", `${authed("alice", alice)}/alice/app.git`, "main"], b);
    await git(["checkout", "-b", "long", "FETCH_HEAD"], b);
    const first = await commit(b, "one.txt");
    await commit(b, "two.txt");
    await git(["push", "origin", "long"], b);
    const number = await open("long");
    const repo = getRepo(app.db, "alice", "app")!;
    const lander = getUserByName(app.db, "alice")!;
    const slice = await landSlice(app, lander, repo, getPull(app.db, repo.id, number)!, first);
    if (!slice.ok) throw new Error(String(slice.error));
    expect(slice.value.last).toBe(false);
    const merged = await mergePull(app, lander, repo, getPull(app.db, repo.id, number)!, "merge");
    if (!merged.ok) throw new Error(String(merged.error));
    const notes = notesOn(number);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`landed in 2 slices: \`${slice.value.mergeOid.slice(0, 12)}\`, \`${merged.value.mergeOid.slice(0, 12)}\``);
    expect(notes[0]).not.toContain("conflicts resolved");
  });
});
