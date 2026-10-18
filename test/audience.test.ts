/**
 * The audience sentence: each wording from plain facts, and the counts read
 * from a seeded database against what `REPO_VISIBLE` and `REPO_WRITABLE` let
 * through.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  audienceFacts,
  audienceOf,
  type AudienceFacts,
} from "../src/core/audience.ts";
import { getRepoById } from "../src/core/repos.ts";
import { getUserById } from "../src/core/users.ts";
import { migrations } from "../src/core/schema.ts";
import { REPO_VISIBLE, REPO_WRITABLE } from "../src/core/visibility.ts";
import { openDb } from "../src/kernel/db.ts";

const base: AudienceFacts = {
  visibility: "private",
  viewer: "person",
  ownerKind: "user",
  ownerName: "ann",
  readers: 0,
  writers: 1,
  viewerWrites: true,
  crew: true,
};

describe("audienceOf", () => {
  test("a private repository of one person", () => {
    expect(audienceOf(base)).toEqual({
      level: "private",
      sentence: "Private: only you and the crew.",
    });
    expect(audienceOf({ ...base, crew: false }).sentence).toBe(
      "Private: only you.",
    );
  });

  test("a private organisation's people", () => {
    const facts = { ...base, ownerKind: "org" as const, ownerName: "acme" };
    expect(audienceOf({ ...facts, readers: 3 }).sentence).toBe(
      "Private: you, 3 people in acme, and the crew.",
    );
    expect(audienceOf({ ...facts, readers: 1, crew: false }).sentence).toBe(
      "Private: you and 1 person in acme.",
    );
  });

  test("a private repository seen by someone who is not its owner", () => {
    expect(audienceOf({ ...base, readers: 1 }).sentence).toBe(
      "Private: you, ann, and the crew.",
    );
  });

  test("a public repository", () => {
    expect(audienceOf({ ...base, visibility: "public", writers: 2 })).toEqual({
      level: "public",
      sentence:
        "Public: anyone can read this; 2 people and the crew can change it.",
    });
    expect(
      audienceOf({ ...base, visibility: "public", writers: 1 }).sentence,
    ).toContain("1 person and the crew can change it");
  });

  test("a signed-out viewer is never called you", () => {
    const out = { ...base, viewer: "signed-out" as const, viewerWrites: false };
    expect(
      audienceOf({
        ...out,
        visibility: "public",
        writers: 2,
        app: { access: "private", writers: 2, named: 1, viewerNamed: false },
      }).sentence,
    ).toBe(
      "The code is public; the app answers only to 2 people who can change it, 1 person it names, and the crew.",
    );
    expect(audienceOf({ ...out, readers: 1 }).sentence).toBe(
      "Private: ann and the crew.",
    );
    expect(audienceOf({ ...out, crew: false }).sentence).toBe("Private: nobody.");
    expect(
      audienceOf({ ...out, visibility: "public", writers: 0, crew: false }).sentence,
    ).toBe("Public: anyone can read this; nobody can change it.");
  });

  test("a private app on a public repository", () => {
    const facts: AudienceFacts = {
      ...base,
      visibility: "public",
      writers: 3,
      app: { access: "private", writers: 2, named: 2, viewerNamed: false },
    };
    expect(audienceOf(facts)).toEqual({
      level: "split",
      sentence:
        "The code is public; the app answers only to you, 2 people who can change it, 2 people it names, and the crew.",
    });
    expect(
      audienceOf({ ...facts, writers: 1, crew: false, app: { access: "private", writers: 0, named: 0, viewerNamed: false } })
        .sentence,
    ).toBe("The code is public; the app answers only to you.");
  });

  test("a public app on a public repository changes nothing", () => {
    const facts = { ...base, visibility: "public" as const };
    expect(audienceOf({ ...facts, app: { access: "public", writers: 0, named: 0, viewerNamed: false } }).level).toBe(
      "public",
    );
  });
});

describe("audienceFacts", () => {
  let db: Database;
  const ins = (sql: string) => db.run(sql);
  const user = (id: string) =>
    ins(
      `INSERT INTO user (id, username, email, password_hash) VALUES ('${id}','${id}','${id}@x','x')`,
    );
  const facts = (repoId: string, viewerId: string | undefined) =>
    audienceFacts(
      db,
      getRepoById(db, repoId)!,
      viewerId ? getUserById(db, viewerId) : undefined,
    );

  beforeAll(() => {
    db = openDb(":memory:", migrations);
    ins("INSERT INTO user (id, username, email, password_hash, kind) VALUES ('acme','acme','a@x','x','org')");
    for (const id of ["ann", "bob", "cy", "dee", "gone", "root"]) user(id);
    ins("UPDATE user SET suspended_at = '2026-01-01T00:00:00Z' WHERE id = 'gone'");
    ins("UPDATE user SET is_admin = 1 WHERE id = 'root'");
    ins("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES ('bot','bot','b@x','x',1)");
    ins("INSERT INTO team (id, org_id, name, permission) VALUES ('t1','acme','read','read'), ('t2','acme','dev','write')");
    ins("INSERT INTO team_member (team_id, user_id) VALUES ('t1','bob'),('t1','cy'),('t2','cy'),('t2','dee'),('t1','gone'),('t2','gone')");
    ins("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('org-priv','acme','p','private'),('org-pub','acme','q','public'),('mine','ann','m','private')");
    ins("INSERT INTO repo_crew (repo_id, user_id) VALUES ('org-priv','bot')");
    ins("INSERT INTO app (id, repo_id, slug, access) VALUES ('a1','org-pub','pub-app','private')");
    ins("INSERT INTO app_member (app_id, user_id) VALUES ('a1','ann'),('a1','gone'),('a1','cy')");
  });

  test("counts match what visibility.ts lets through", () => {
    const every = (rule: string, repoId: string) =>
      db
        .query<{ id: string }, [string]>(
          `SELECT cand.id FROM user AS cand WHERE cand.kind = 'user' AND cand.is_agent = 0
             AND cand.is_admin = 0 AND cand.suspended_at IS NULL
             AND EXISTS (SELECT 1 FROM repo WHERE repo.id = ?1 AND ${rule.replaceAll("?1", "cand.id")})`,
        )
        .all(repoId)
        .map((r) => r.id);
    const readers = every(REPO_VISIBLE, "org-priv");
    expect(readers.sort()).toEqual(["bob", "cy", "dee"]);
    const f = facts("org-priv", "ann");
    expect(f.readers).toBe(readers.length);
    expect(f.writers).toBe(every(REPO_WRITABLE, "org-priv").length);
    expect(f.writers).toBe(2);
    expect(f.crew).toBe(true);
    expect(f.ownerKind).toBe("org");
  });

  test("the viewer is not counted among the readers, and may write", () => {
    const f = facts("org-priv", "cy");
    expect(f.readers).toBe(2);
    expect(f.viewerWrites).toBe(true);
    expect(facts("org-priv", "bob").viewerWrites).toBe(false);
    expect(audienceOf(facts("org-priv", "cy")).sentence).toBe(
      "Private: you, 2 people in acme, and the crew.",
    );
  });

  test("a personal repository has no one but its owner", () => {
    expect(audienceOf(facts("mine", "ann"))).toEqual({
      level: "private",
      sentence: "Private: only you.",
    });
    expect(facts("mine", "ann").writers).toBe(1);
  });

  test("a private app names its active people", () => {
    const f = facts("org-pub", "dee");
    expect(f.app).toEqual({
      access: "private",
      writers: 1,
      named: 1,
      viewerNamed: false,
    });
    expect(audienceOf(f).sentence).toBe(
      "The code is public; the app answers only to you, 1 person who can change it, and 1 person it names.",
    );
  });

  test("a writer who is also named is counted once", () => {
    // cy writes and is named; ann is only named; dee only writes.
    const f = facts("org-pub", undefined);
    expect(f.app).toMatchObject({ writers: 2, named: 1 });
    expect(audienceOf(f).sentence).toBe(
      "The code is public; the app answers only to 2 people who can change it and 1 person it names.",
    );
    const asCy = facts("org-pub", "cy");
    expect(asCy.app).toMatchObject({ writers: 1, named: 1, viewerNamed: true });
  });

  test("a named viewer who cannot write is 'you', and not counted again", () => {
    const f = facts("org-pub", "ann");
    expect(f.viewerWrites).toBe(false);
    expect(f.app).toMatchObject({ writers: 2, named: 0, viewerNamed: true });
    expect(audienceOf(f).sentence).toBe(
      "The code is public; the app answers only to you and 2 people who can change it.",
    );
  });

  test("a viewer who neither writes nor is named is not told 'you'", () => {
    for (const id of ["bob", "root"]) {
      const f = facts("org-pub", id);
      expect(audienceOf(f).sentence).not.toContain("you");
    }
    expect(audienceOf(facts("org-pub", "bob")).sentence).toBe(
      "The code is public; the app answers only to 2 people who can change it and 1 person it names.",
    );
  });

  test("an admin viewer is told 'you' and counted like a person", () => {
    const f = facts("org-priv", "root");
    expect(f.viewer).toBe("admin");
    // Their reach is the forge's: membership of the repository is what counts.
    expect(f.viewerWrites).toBe(false);
    expect(f.readers).toBe(3);
    expect(audienceOf(f).sentence).toBe(
      "Private: you, 3 people in acme, and the crew.",
    );
  });

  test("an anonymous viewer is no one", () => {
    const f = facts("org-pub", undefined);
    expect(f.viewer).toBe("signed-out");
    expect(audienceOf(f).sentence).toBe(
      "The code is public; the app answers only to 2 people who can change it and 1 person it names.",
    );
    expect(f.viewerWrites).toBe(false);
    expect(f.writers).toBe(2);
  });
});
