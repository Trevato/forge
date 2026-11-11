/**
 * The actions layer is the one place authorization and events live. These
 * tests drive it directly — no HTTP — and prove the gates hold there, so a
 * new surface (the TUI) inherits them by construction rather than by
 * remembering to add checks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComment, openIssue, setIssueState } from "../src/actions/issues.ts";
import {
  addTeamMember,
  createOrg,
  createTeam,
  deleteTeam,
} from "../src/actions/orgs.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createLabel,
  createRepo,
  createWebhook,
  deleteRepo,
  forkRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { getOrg, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { seedAdmin } from "./helpers/admin.ts";

/** Event kinds in chronological order (listEvents returns newest first). */
const kinds = (app: App, repoId?: string) =>
  listEvents(app.db, repoId === undefined ? {} : { repoId })
    .map((e) => e.kind)
    .reverse();

describe("actions own authorization and events", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let secret: Repo;
  let open: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-actions-"));
    app = createApp({ dataDir, port: 0 });
    const a = await signUp(app, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    const b = await signUp(app, {
      username: "bob",
      email: "bob@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    promote(app.db, alice, bob);
    const s = await createRepo(app, alice, { name: "secret" });
    const o = await createRepo(app, alice, {
      name: "open",
      visibility: "public",
    });
    if (!s.ok || !o.ok) throw new Error("repo creation failed");
    secret = s.value;
    open = o.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("signing up records user.created; no sign-up is the admin, the first neither", () => {
    expect(alice.isAdmin).toBe(false);
    expect(bob.isAdmin).toBe(false);
    expect(kinds(app).filter((k) => k === "user.created")).toHaveLength(2);
  });

  test("creating a repo needs an actor and records repo.created", async () => {
    const anon = await createRepo(app, undefined, { name: "x" });
    expect(anon).toEqual({ ok: false, error: "unauthorized" });
    expect(kinds(app, secret.id)).toEqual(["repo.created"]);
  });

  test("a stranger cannot create under someone else's name", async () => {
    const r = await createRepo(app, bob, { owner: "alice", name: "sneaky" });
    expect(r).toEqual({ ok: false, error: "forbidden_owner" });
    expect(getRepo(app.db, "alice", "sneaky")).toBeUndefined();
  });

  test("a private repo is not_found to outsiders at every tier", async () => {
    const before = kinds(app, secret.id).length;
    expect(openIssue(app, bob, secret, { title: "hi" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(openIssue(app, undefined, secret, { title: "hi" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await forkRepo(app, bob, secret)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await commitToBranch(app, bob, secret, {
        files: [{ path: "a", content: "b" }],
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await updateRepoSettings(app, bob, secret, { description: "x" }),
    ).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await deleteRepo(app, bob, secret)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(kinds(app, secret.id).length).toBe(before);
    expect(getRepo(app.db, "alice", "secret")).toBeDefined();
  });

  test("a public repo distinguishes anonymous, reader, and writer", async () => {
    // Anyone signed in may open an issue; anonymous may not.
    expect(openIssue(app, undefined, open, { title: "hi" })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    const issue = openIssue(app, bob, open, { title: "bob's issue" });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Writing files is a writer's privilege: forbidden, not hidden.
    expect(
      await commitToBranch(app, bob, open, {
        files: [{ path: "a", content: "b" }],
      }),
    ).toEqual({ ok: false, error: "forbidden" });

    // Admin surfaces stay hidden even on a public repo.
    expect(createLabel(app, bob, open, "bug", "ff0000")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      createWebhook(app, bob, open, { url: "https://example.com/h" }),
    ).toEqual({ ok: false, error: "not_found" });

    expect(kinds(app, open.id)).toEqual(["repo.created", "issue.opened"]);
  });

  test("close/reopen admits the author and writers, nobody else", async () => {
    const issue = openIssue(app, bob, open, { title: "moderation" });
    if (!issue.ok) throw new Error("open failed");
    const carol = await signUp(app, {
      username: "carol",
      email: "carol@forge.test",
      password: "a-long-passphrase",
    });
    if (!carol.ok) throw new Error("signup failed");

    expect(
      setIssueState(app, carol.value, open, issue.value, "closed"),
    ).toEqual({ ok: false, error: "forbidden" });
    const closed = setIssueState(app, bob, open, issue.value, "closed");
    expect(closed.ok && closed.value.state).toBe("closed");
    // A repeat is a no-op: same state back, no second event.
    const again = setIssueState(app, alice, open, issue.value, "closed");
    expect(again.ok && again.value.state).toBe("closed");
    expect(
      kinds(app, open.id).filter((k) => k === "issue.closed"),
    ).toHaveLength(1);
    const reopened = setIssueState(app, alice, open, issue.value, "open");
    expect(reopened.ok && reopened.value.state).toBe("open");
    expect(kinds(app, open.id)).toContain("issue.reopened");
  });

  test("an issue from another repo cannot be addressed through this one", () => {
    const foreign = openIssue(app, alice, secret, { title: "private" });
    if (!foreign.ok) throw new Error("open failed");
    expect(addComment(app, bob, open, foreign.value, "peek")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  test("the pull loop: open, comment, merge — events in order", async () => {
    const seeded = await commitToBranch(app, alice, open, {
      message: "seed",
      files: [{ path: "README.md", content: "hello\n" }],
    });
    expect(seeded.ok).toBe(true);
    const branched = await commitToBranch(app, alice, open, {
      branch: "feature",
      message: "feature",
      files: [{ path: "feature.txt", content: "yes\n" }],
    });
    expect(branched.ok).toBe(true);

    const pull = await openPull(app, bob, open, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    expect(pull.ok).toBe(true);
    if (!pull.ok) return;

    const said = addComment(app, bob, open, pull.value, "looks good");
    expect(said.ok).toBe(true);
    // Bob can read but not write: merging is forbidden and leaves no trace.
    expect(await mergePull(app, bob, open, pull.value, "merge")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(getPull(app.db, open.id, pull.value.number)?.mergedAt).toBeNull();

    const merged = await mergePull(app, alice, open, pull.value, "squash");
    expect(merged.ok).toBe(true);
    expect(
      getPull(app.db, open.id, pull.value.number)?.mergedAt,
    ).not.toBeNull();

    const tail = kinds(app, open.id).slice(-5);
    expect(tail).toEqual([
      "push",
      "push",
      "pull.opened",
      "pull.commented",
      "pull.merged",
    ]);
  });

  test("forking records the lineage event; deleting records repo.deleted", async () => {
    const fork = await forkRepo(app, bob, open);
    expect(fork.ok).toBe(true);
    if (!fork.ok) return;
    const forkEvents = listEvents(app.db, { repoId: fork.value.id }).reverse();
    expect(forkEvents.map((e) => e.kind)).toEqual(["repo.forked"]);
    expect(forkEvents[0]?.payload).toEqual({ parent: "alice/open" });

    const gone = await deleteRepo(app, bob, fork.value);
    expect(gone.ok).toBe(true);
    expect(getRepo(app.db, "bob", "open")).toBeUndefined();
    expect(kinds(app)).toContain("repo.deleted");
  });

  test("org teams are admin-only and hidden to everyone else", () => {
    const org = createOrg(app, alice, "acme");
    expect(org.ok).toBe(true);
    expect(kinds(app)).toContain("org.created");
    const acme = getOrg(app.db, "acme")!;

    expect(createTeam(app, bob, acme, "devs", "write")).toEqual({
      ok: false,
      error: "not_found",
    });
    const devs = createTeam(app, alice, acme, "devs", "write");
    expect(devs.ok).toBe(true);
    if (!devs.ok) return;

    expect(addTeamMember(app, bob, acme, devs.value, "bob")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(addTeamMember(app, alice, acme, devs.value, "nobody")).toEqual({
      ok: false,
      error: "no_such_user",
    });
    expect(addTeamMember(app, alice, acme, devs.value, "bob")).toEqual({
      ok: true,
      value: { added: true, role: "member" },
    });

    // Bob is now a writer in acme — but still not an admin.
    expect(createTeam(app, bob, acme, "ops", "read")).toEqual({
      ok: false,
      error: "not_found",
    });

    const owners = listTeams(app.db, acme.id).find(
      (t) => t.name === OWNERS_TEAM,
    )!;
    expect(deleteTeam(app, alice, acme, owners)).toEqual({
      ok: false,
      error: "protected",
    });
    expect(deleteTeam(app, alice, acme, devs.value)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("a team from another org cannot be driven through this one", () => {
    const other = createOrg(app, bob, "globex");
    if (!other.ok) throw new Error("org failed");
    const globex = getOrg(app.db, "globex")!;
    const acme = getOrg(app.db, "acme")!;
    const globexOwners = listTeams(app.db, globex.id)[0]!;
    // Alice admins acme, not globex — routing globex's team via acme must fail.
    expect(addTeamMember(app, alice, acme, globexOwners, "alice")).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("sign-up races", () => {
  test("two simultaneous first accounts made admin if first yield exactly one admin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-race-"));
    const fresh = createApp({ dataDir: dir });
    try {
      const [a, b] = await Promise.all([
        createUser(fresh.db, { origin: "seed", adminIfFirst: true, username: "one", email: "one@x.io", password: "a-good-passphrase" }),
        createUser(fresh.db, { origin: "seed", adminIfFirst: true, username: "two", email: "two@x.io", password: "a-good-passphrase" }),
      ]);
      if (!a.ok || !b.ok) throw new Error("sign-ups failed");
      expect([a.value.isAdmin, b.value.isAdmin].filter(Boolean)).toHaveLength(1);
    } finally {
      fresh.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two simultaneous sign-ups for one username settle without a throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-race-"));
    const fresh = createApp({ dataDir: dir });
    try {
      const results = await Promise.all([
        signUp(fresh, { username: "same", email: "s1@x.io", password: "a-good-passphrase" }),
        signUp(fresh, { username: "same", email: "s2@x.io", password: "a-good-passphrase" }),
      ]);
      const errors = results.filter((r) => !r.ok).map((r) => (r as { error: string }).error);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(errors).toEqual(["username_taken"]);
    } finally {
      fresh.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("free-text caps", () => {
  test("titles and bodies over the caps are refused with a specific code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-caps-"));
    const fresh = createApp({ dataDir: dir });
    try {
      const u = await seedAdmin(fresh, { username: "cap", email: "cap@x.io", password: "a-good-passphrase" });
      if (!u.ok) throw new Error("sign-up failed");
      const r = await createRepo(fresh, u.value, { name: "caps", visibility: "public" });
      if (!r.ok) throw new Error("repo failed");
      expect(openIssue(fresh, u.value, r.value, { title: "x".repeat(257) })).toEqual({ ok: false, error: "title_too_long" });
      expect(openIssue(fresh, u.value, r.value, { title: "ok", body: "y".repeat(65_537) })).toEqual({ ok: false, error: "body_too_long" });
      const issue = openIssue(fresh, u.value, r.value, { title: "x".repeat(256), body: "y".repeat(65_536) });
      expect(issue.ok).toBe(true);
      if (!issue.ok) return;
      expect(addComment(fresh, u.value, r.value, issue.value, "z".repeat(65_537))).toEqual({ ok: false, error: "body_too_long" });
    } finally {
      fresh.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
