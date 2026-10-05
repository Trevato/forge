/**
 * A pull can be held (#773): a person who writes the repository says "not
 * this one yet", and until it is released no rule sends the pull to review
 * or lands it. The refusals come first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {
  cleanWhy,
  getHold,
  holdsFor,
  lastRelease,
  releaseHold,
  setHold,
  WHY_MAX,
} from "../src/core/holds.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";

describe("a hold, as it is kept", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let pull: Pull;
  let other: Pull;

  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const pullOn = async (branch: string): Promise<Pull> => {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: `Change ${branch}`,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-holds-core-"));
    app = createApp({ dataDir, port: 0 });
    alice = await person("alice");
    bob = await person("bob");
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
    pull = await pullOn("one");
    other = await pullOn("two");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the reason is one plain line, and there must be one", () => {
    expect(cleanWhy("  a second review\n is under way ")).toEqual({
      ok: true,
      value: "a second review is under way",
    });
    expect(cleanWhy(" \n ")).toEqual({ ok: false, error: "empty_why" });
    expect(cleanWhy("x".repeat(WHY_MAX)).ok).toBe(true);
    expect(cleanWhy("x".repeat(WHY_MAX + 1))).toEqual({
      ok: false,
      error: "why_too_long",
    });
  });

  test("a pull holds one hold, with who and why; a second replaces the words and keeps the time", () => {
    expect(getHold(app.db, pull.id)).toBeUndefined();
    const first = setHold(app.db, pull.id, alice.id, "second review under way");
    expect([first.heldByName, first.why]).toEqual([
      "alice",
      "second review under way",
    ]);
    const second = setHold(app.db, pull.id, bob.id, "waiting for the release");
    expect([second.heldByName, second.why, second.heldAt]).toEqual([
      "bob",
      "waiting for the release",
      first.heldAt,
    ]);
    const rows = app.db
      .query("SELECT count(*) AS n FROM pull_hold WHERE issue_id = ?1")
      .get(pull.id) as { n: number };
    expect(rows.n).toBe(1);
    expect([...holdsFor(app.db, [pull.id, other.id]).keys()]).toEqual([
      pull.id,
    ]);
  });

  test("a release is kept: nothing stands, and the pull remembers when it was let go", () => {
    expect(lastRelease(app.db, other.id)).toBeUndefined();
    expect(releaseHold(app.db, other.id, alice.id)).toBe(false);
    expect(releaseHold(app.db, pull.id, alice.id)).toBe(true);
    expect(getHold(app.db, pull.id)).toBeUndefined();
    expect(holdsFor(app.db, [pull.id]).size).toBe(0);
    const released = lastRelease(app.db, pull.id);
    expect(Date.parse(released ?? "")).toBeGreaterThan(Date.now() - 60_000);
    // Held again, it is a new hold; the earlier one is history.
    setHold(app.db, pull.id, alice.id, "once more");
    expect(getHold(app.db, pull.id)?.why).toBe("once more");
    expect(lastRelease(app.db, pull.id)).toBe(released);
  });
});
