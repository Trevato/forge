/** The pile (#6472): open crew pulls counted once each, in the first pile they fit. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";
import { pileSays, readPile } from "../src/flow/pile.ts";

let root: string;
let app: App;
let ownerId: string;
let atlasId: string;
let strangerId: string;
let pub: string;
let priv: string;
let n = 0;
let seq = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-pile-"));
  app = createApp({ dataDir: root, port: 0 });
  const made = await createUser(app.db, { username: "trevato", email: "t@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  ownerId = made.value.id;
  const other = await createUser(app.db, { username: "stranger", email: "s@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
  if (!other.ok) throw new Error(other.error);
  strangerId = other.value.id;
  const atlas = await createUser(app.db, { origin: "seed", username: "atlas", email: "atlas@forge.test", agent: true });
  if (!atlas.ok) throw new Error("agent");
  atlasId = atlas.value.id;
  createAgentRow(app.db, { userId: atlasId, brief: "plan", createdBy: ownerId });
  for (const [name, visibility] of [["open", "public"], ["secret", "private"]] as const) {
    const repo = await createRepo(app.db, app.reposRoot, { ownerId, name, visibility, description: "r" });
    if (!repo.ok) throw new Error(repo.error);
    addCrew(app.db, repo.value.id, atlasId, ownerId);
    if (name === "open") pub = repo.value.id;
    else priv = repo.value.id;
  }
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

function pull(repoId: string, opts: { author?: string; merged?: boolean; state?: string } = {}): string {
  const issue = id();
  const number = ++n;
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, ?5)`)
    .run(issue, repoId, number, opts.author ?? atlasId, opts.state ?? "open");
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, 'main', 'b', '', 'h', ?2, ?3)`)
    .run(issue, repoId, opts.merged ? "2026-10-26T00:00:00.000Z" : null);
  return issue;
}
function run(repoId: string, issue: string, kind: string, state: string, reason = ""): void {
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, reason) VALUES (?1, ?2, ?3, ?4, 'h', ?5, ?6)`)
    .run(`${String(++seq).padStart(4, "0")}${id()}`, repoId, kind, issue, state, reason);
}
function review(issue: string, state: string): void {
  app.db
    .query(`INSERT INTO review (id, issue_id, author_id, state) VALUES (?1, ?2, ?3, ?4)`)
    .run(`${String(++seq).padStart(4, "0")}${id()}`, issue, ownerId, state);
}
const clear = (): void => {
  for (const t of ["review", "run", "pull", "issue"]) app.db.query(`DELETE FROM ${t}`).run();
};

describe("flow pile", () => {
  test("nothing yet reads zero", () => {
    clear();
    expect(readPile(app.db)).toEqual({ red: 0, conflicted: 0, changesAsked: 0, approved: 0, awaitingReview: 0, total: 0 });
  });

  test("one pull in each pile, a merged pull left out, and the piles add up to total", () => {
    clear();
    run(pub, pull(pub), "check", "failed");
    run(pub, pull(pub), "agent", "queued", "conflict");
    review(pull(pub), "changes_requested");
    review(pull(pub), "approved");
    pull(pub);
    const merged = pull(pub, { merged: true, state: "closed" });
    run(pub, merged, "check", "failed");
    const pile = readPile(app.db);
    expect(pile).toEqual({ red: 1, conflicted: 1, changesAsked: 1, approved: 1, awaitingReview: 1, total: 5 });
    expect(pile.red + pile.conflicted + pile.changesAsked + pile.approved + pile.awaitingReview).toBe(pile.total);
  });

  test("a pull is counted once, in the first pile it fits", () => {
    clear();
    const a = pull(pub);
    run(pub, a, "check", "failed");
    run(pub, a, "agent", "failed", "conflict");
    review(a, "approved");
    const b = pull(pub);
    run(pub, b, "agent", "running", "conflict");
    review(b, "changes_requested");
    const c = pull(pub);
    review(c, "approved");
    review(c, "changes_requested");
    const d = pull(pub);
    review(d, "changes_requested");
    review(d, "approved");
    review(d, "commented");
    expect(readPile(app.db)).toEqual({ red: 1, conflicted: 1, changesAsked: 1, approved: 1, awaitingReview: 0, total: 4 });
  });

  test("only crew agents' pulls count, and publicOnly leaves private repositories out", () => {
    clear();
    pull(pub, { author: strangerId });
    pull(pub, { author: ownerId });
    pull(pub);
    pull(priv);
    expect(readPile(app.db).total).toBe(2);
    expect(readPile(app.db, true)).toEqual({ red: 0, conflicted: 0, changesAsked: 0, approved: 0, awaitingReview: 1, total: 1 });
  });

  test("the /boards panel and the terminal flow screen say the same counts, in the sort order; an agent reads public only", () => {
    clear();
    run(pub, pull(pub), "check", "failed");
    review(pull(pub), "approved");
    pull(priv);
    const says = pileSays(readPile(app.db));
    expect(says).toContain("3 open crew pulls");
    expect(says).toContain("1 red, 0 conflicted, 0 changes asked, 1 approved and waiting, 1 awaiting review");
    const page = String(flowPanel(app, { kind: "owner" }, new URL("http://x/boards"), "/boards"));
    expect(page).toContain(`<p id="pile">${says}</p>`);
    expect(flowLines(app.db).join(" ")).toContain("1 red, 0 conflicted, 0 changes asked, 1 approved and waiting, 1 awaiting review");
    const agent = String(flowPanel(app, { kind: "agent" }, new URL("http://x/boards"), "/boards"));
    expect(agent).toContain("2 open crew pulls");
    expect(flowLines(app.db, new Date(), undefined, { queues: [] }).join(" ")).toContain("2 open crew pulls");
  });
});
