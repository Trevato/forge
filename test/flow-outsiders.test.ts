/** The outsider count (#5930): a writer's and a crew agent's pulls are left out; a stranger's is counted with its age. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { readOutsiders } from "../src/flow/outsiders.ts";

const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

async function world() {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-outsiders-")), port: 0 });
  const person = async (username: string, extra: object = {}) => {
    const made = await createUser(app.db, { username, email: `${username}@forge.test`, password: "a-good-passphrase", origin: "seed", trusted: true, ...extra });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const alice = await person("alice", { adminIfFirst: true });
  const stranger = await person("stranger");
  const atlasMade = await createUser(app.db, { origin: "seed", username: "atlas", email: "atlas@forge.test", agent: true });
  if (!atlasMade.ok) throw new Error("agent");
  createAgentRow(app.db, { userId: atlasMade.value.id, brief: "plan", createdBy: alice.id });
  const repo = async (name: string, visibility: "public" | "private") => {
    const r = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name, visibility, description: name });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  let n = 0;
  const pull = (repoId: string, branch: string, authorId: string, opened: string, merged: string | null = null, state = "open", originAuthor: string | null = null) => {
    const issueId = id();
    n++;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, origin_author) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, ?6, ?7, ?8)`)
      .run(issueId, repoId, n, `P${n}`, authorId, state, opened, originAuthor);
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`)
      .run(issueId, branch, `b/${n}`, repoId, merged);
  };
  return { app, alice, stranger, atlas: atlasMade.value, repo, pull };
}

describe("flow outsiders", () => {
  test("a writer's and a crew pull are left out; a stranger's is counted with its age", async () => {
    const w = await world();
    const r = await w.repo("o", "public");
    addCrew(w.app.db, r.id, w.atlas.id, w.alice.id);
    const b = r.defaultBranch;
    expect(readOutsiders(w.app.db, NOW)).toEqual({ open: 0, oldestHours: 0 });
    w.pull(r.id, b, w.alice.id, ago(100));
    w.pull(r.id, b, w.atlas.id, ago(90));
    expect(readOutsiders(w.app.db, NOW)).toEqual({ open: 0, oldestHours: 0 });
    w.pull(r.id, b, w.stranger.id, ago(5));
    w.pull(r.id, b, w.stranger.id, ago(30.5));
    w.pull(r.id, b, w.stranger.id, ago(200), ago(1), "closed"); // merged: not waiting
    w.pull(r.id, b, w.stranger.id, ago(300), null, "closed"); // closed: not waiting
    expect(readOutsiders(w.app.db, NOW)).toEqual({ open: 2, oldestHours: 30 });
  });

  test("an open pull with merged_at set is not waiting", async () => {
    const w = await world();
    const r = await w.repo("o", "public");
    w.pull(r.id, r.defaultBranch, w.stranger.id, ago(10), ago(1), "open");
    expect(readOutsiders(w.app.db, NOW)).toEqual({ open: 0, oldestHours: 0 });
  });

  test("an imported pull is an outsider's even with a writer's id; an empty origin author is not", async () => {
    const w = await world();
    const r = await w.repo("o", "public");
    addCrew(w.app.db, r.id, w.atlas.id, w.alice.id);
    w.pull(r.id, r.defaultBranch, w.alice.id, ago(7), null, "open", "octocat");
    w.pull(r.id, r.defaultBranch, w.atlas.id, ago(8), null, "open", "");
    w.pull(r.id, r.defaultBranch, w.alice.id, ago(9), null, "open", "");
    expect(readOutsiders(w.app.db, NOW)).toEqual({ open: 1, oldestHours: 7 });
  });

  test("an agent that is not this repository's crew is an outsider", async () => {
    const w = await world();
    const r = await w.repo("o", "public");
    w.pull(r.id, r.defaultBranch, w.atlas.id, ago(2));
    expect(readOutsiders(w.app.db, NOW).open).toBe(1);
  });

  test("publicOnly hides private repositories", async () => {
    const w = await world();
    const pub = await w.repo("pub", "public");
    const priv = await w.repo("priv", "private");
    w.pull(pub.id, pub.defaultBranch, w.stranger.id, ago(3));
    w.pull(priv.id, priv.defaultBranch, w.stranger.id, ago(40));
    expect(readOutsiders(w.app.db, NOW)).toEqual({ open: 2, oldestHours: 40 });
    expect(readOutsiders(w.app.db, NOW, true)).toEqual({ open: 1, oldestHours: 3 });
  });
});
