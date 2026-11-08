/**
 * Who sees a sealed issue (#621): the predicates of `core/sealed.ts`, called
 * directly on a seeded repository. An unsealed issue is for anyone who can
 * read; a sealed one is for its author while active, the repository's
 * writers and its crew; a run or event about it answers the same way, and
 * the preview of a sealed pull says only yes or no.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setSuspended } from "../src/core/accounts.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import {
  canSeeSealed,
  mayView,
  mayViewId,
  sealedPreview,
  sealedScope,
} from "../src/core/sealed.ts";
import { createUser, getUserById, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let owner: User;
let author: User;
let stranger: User;
let crew: User;
let outsideAgent: User;
let repo: Repo;
let open: Issue;
let sealed: Issue;
let sealedPull: Issue;

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const person = async (username: string, first = false) =>
  ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    }),
  );

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sealed-pred-"));
  app = createApp({ dataDir, port: 0 });
  owner = await person("alice", true);
  author = await person("reporter");
  stranger = await person("stranger");
  repo = ok(
    await createRepo(app, owner, { name: "square", visibility: "public" }),
  );
  crew = ok(await createAgent(app, owner, { username: "bot" })).user;
  outsideAgent = ok(await createAgent(app, owner, { username: "drifter" })).user;
  expect(addToCrew(app, owner, repo, "bot").ok).toBe(true);
  const file = (title: string, sealedFlag: boolean, kind?: "pull") =>
    ok(
      createIssue(app.db, {
        repoId: repo.id,
        authorId: author.id,
        title,
        body: `body of ${title}`,
        sealed: sealedFlag,
        ...(kind ? { kind } : {}),
      }),
    );
  open = file("Open question", false);
  sealed = file("Secret hole", true);
  sealedPull = file("Secret fix", true, "pull");
});

afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("mayView", () => {
  test("an unsealed issue is visible to anyone who can read the repository", () => {
    for (const who of [undefined, stranger, author, owner, crew])
      expect(mayView(app.db, repo, open, who)).toBe(true);
  });

  test("a sealed issue is visible to its author, a writer and the crew", () => {
    expect(mayView(app.db, repo, sealed, author)).toBe(true);
    expect(mayView(app.db, repo, sealed, owner)).toBe(true);
    expect(mayView(app.db, repo, sealed, crew)).toBe(true);
  });

  test("a sealed issue is not visible to a stranger, a reader or no one", () => {
    expect(mayView(app.db, repo, sealed, stranger)).toBe(false);
    expect(mayView(app.db, repo, sealed, undefined)).toBe(false);
    // An agent outside this crew is a reader like any other.
    expect(mayView(app.db, repo, sealed, outsideAgent)).toBe(false);
  });

  test("the author is not its own reader once suspended", () => {
    setSuspended(app.db, author.id, "2026-01-01T00:00:00.000Z");
    try {
      const suspended = getUserById(app.db, author.id)!;
      expect(mayView(app.db, repo, sealed, suspended)).toBe(false);
      expect(mayView(app.db, repo, open, suspended)).toBe(true);
    } finally {
      setSuspended(app.db, author.id, null);
    }
    expect(mayView(app.db, repo, sealed, getUserById(app.db, author.id))).toBe(
      true,
    );
  });

  test("the author sees only their own: another's sealed issue stays shut", () => {
    const theirs = { sealed: true, authorId: stranger.id };
    expect(mayView(app.db, repo, theirs, author)).toBe(false);
  });
});

describe("canSeeSealed and sealedScope", () => {
  test("only writers and the crew see sealed issues of a repository", () => {
    expect(canSeeSealed(app.db, repo, owner)).toBe(true);
    expect(canSeeSealed(app.db, repo, crew)).toBe(true);
    expect(canSeeSealed(app.db, repo, author)).toBe(false);
    expect(canSeeSealed(app.db, repo, stranger)).toBe(false);
    expect(canSeeSealed(app.db, repo, outsideAgent)).toBe(false);
    expect(canSeeSealed(app.db, repo, undefined)).toBe(false);
  });

  test("a list includes all, one's own, or none", () => {
    expect(sealedScope(app.db, repo, owner)).toEqual({ sealed: true });
    expect(sealedScope(app.db, repo, author)).toEqual({ sealedBy: author.id });
    expect(sealedScope(app.db, repo, undefined)).toEqual({});
  });
});

describe("mayViewId", () => {
  test("a run or event about an issue gets the issue's answer", () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: sealed.id,
    });
    for (const who of [undefined, stranger, outsideAgent, author, owner, crew]) {
      expect(mayViewId(app.db, repo, run.issueId, who)).toBe(
        mayView(app.db, repo, sealed, who),
      );
      expect(mayViewId(app.db, repo, open.id, who)).toBe(true);
    }
    expect(mayViewId(app.db, repo, run.issueId, stranger)).toBe(false);
    expect(mayViewId(app.db, repo, run.issueId, owner)).toBe(true);
  });

  test("no issue id is visible to all; an unknown id is no secret", () => {
    for (const who of [undefined, stranger, author, owner])
      expect(mayViewId(app.db, repo, null, who)).toBe(true);
    expect(mayViewId(app.db, repo, "no-such-issue", undefined)).toBe(true);
  });
});

describe("sealedPreview", () => {
  test("names only whether a preview is a sealed pull's, never its title or body", () => {
    const env = `pull-${sealedPull.number}`;
    const answer = sealedPreview(app.db, repo.id, env);
    expect(answer).toBe(true);
    expect(typeof answer).toBe("boolean");
    expect(JSON.stringify(answer)).not.toContain("Secret");
    expect(sealedPreview(app.db, repo.id, `pull-${open.number}`)).toBe(false);
    expect(sealedPreview(app.db, repo.id, "pull-99999")).toBe(false);
    expect(sealedPreview(app.db, repo.id, "production")).toBe(false);
  });

  test("a stranger is refused what the preview gate would show", () => {
    // The gate asks `sealedPreview`, then `mayView` on the row: a stranger fails it.
    expect(sealedPreview(app.db, repo.id, `pull-${sealedPull.number}`)).toBe(true);
    expect(mayView(app.db, repo, sealedPull, stranger)).toBe(false);
    expect(mayView(app.db, repo, sealedPull, undefined)).toBe(false);
    expect(mayView(app.db, repo, sealedPull, crew)).toBe(true);
  });
});
