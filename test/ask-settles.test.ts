/**
 * An ask always offers an action that settles it (#8699): none only opens a
 * page. An assigned pull or issue can go to the crew, be closed, and — when
 * it is green with nothing asked of it — land. A pull a person holds with
 * changes requested goes back to its builder after a day of their silence.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepStranded, STRANDED_LINE } from "../src/crew/stranded.ts";
import { crewHandFor, crewHandsFor, giveBack } from "../src/actions/give_back.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { id } from "../src/kernel/id.ts";
import { ASK_WORDS, type Decision, type DecisionKind } from "../src/web/studio/asks.ts";
import { decisionButtons, decisionForm, decisionsFor } from "../src/web/studio/decisions.ts";
import type { Ctx } from "../src/http/context.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ZERO = "0".repeat(40);
const DAY = 24 * 3_600_000;
/** What settles each kind: the posts its buttons reach, the box where a word is said, or the settings that lift a ceiling. */
const SETTLES: Record<DecisionKind, readonly string[]> = {
  look: ["post /alice/p/pulls/N/ship", "say"],
  review: ["post /alice/p/pulls/N/ship", "say"],
  waiting: ["post /alice/p/pulls/N/ship", "say", "/state"],
  stopped: ["say", "/state"],
  parked: ["say"],
  handover: ["say", "/state"],
  declined: ["say"],
  assigned: ["/state"],
  proposal: ["post /asks/proposal/p1/approve", "post /asks/proposal/p1/later"],
  paused: ["settings"],
};

describe("an ask settles", () => {
  let dir = "";
  let app: App;
  let owner: User;
  let builder: User;
  let reviewer: User;
  let repo: Repo;
  let n = 0;
  const ctx = () => ({ app, auth: { user: owner } }) as unknown as Ctx;

  const person = async (username: string) => {
    const made = await createUser(app.db, { username, email: `${username}@forge.test`, password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const agent = async (username: string, role: "builder" | "reviewer") => {
    const made = await createUser(app.db, { username, email: `${username}@forge.test`, agent: true, origin: "agent" });
    if (!made.ok) throw new Error(made.error);
    createAgentRow(app.db, { userId: made.value.id, brief: "b" });
    addCrew(app.db, repo.id, made.value.id, owner.id);
    seatAs(app.db, repo.id, made.value.id, role);
    return made.value;
  };
  const work = (kind: "pull" | "issue", assignee: User | null, createdAt = new Date().toISOString()): Issue => {
    const wid = id();
    const number = ++n;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, assignee_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, 'open', ?7, ?8)`)
      .run(wid, repo.id, number, kind, `Work ${number}`, builder.id, assignee?.id ?? null, createdAt);
    if (kind === "pull") {
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
        .run(wid, `b/${number}`, ZERO, repo.id);
      app.db.query(`INSERT INTO run (id, repo_id, kind, issue_id, env, commit_oid, branch, actor_id, reason, state, created_at) VALUES (?1, ?2, 'agent', ?3, 'preview', ?4, 'b', ?5, 'feedback', 'ok', ?6)`)
        .run(id(), repo.id, wid, ZERO, builder.id, createdAt);
    }
    return getIssueById(app.db, wid)!;
  };
  const changes = (pull: Issue, at: string) =>
    submitReview(app.db, { issueId: pull.id, authorId: reviewer.id, state: "changes_requested", body: "no", commitOid: ZERO, createdAt: at });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-ask-settles-"));
    app = createApp({ dataDir: dir, port: 0 });
    owner = await person("alice");
    promote(app.db, owner);
    const made = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "p", visibility: "public", description: "p" });
    if (!made.ok) throw new Error(made.error);
    repo = made.value;
    builder = await agent("builder", "builder");
    reviewer = await agent("reviewer", "reviewer");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("every kind of ask has a button that settles it, never only a link that opens a page", () => {
    const pull = work("pull", null);
    const issue = work("issue", null);
    const base = {
      repo,
      who: "x",
      says: "s",
      short: "s",
      consequence: { score: 1, why: "w" },
      waiting: { on: "person" },
    } as unknown as Omit<Decision, "kind" | "id">;
    const proposal = { id: "p1", repoId: repo.id, authorId: builder.id, title: "t", why: "w", issues: [], state: "open", createdAt: "" };
    const kinds = Object.keys(ASK_WORDS) as DecisionKind[];
    expect(kinds.length).toBeGreaterThan(8);
    for (const kind of kinds) {
      const d = { ...base, kind, id: `${kind}:x`, pull, issue, proposal } as unknown as Decision;
      const { primary, others } = decisionButtons(ctx(), d);
      const forms = String(decisionForm(d) ?? "");
      // Each button's `form=` names a form this kind renders; the action it posts to is what settles it.
      const reached = [primary, ...others].map(String).flatMap((h) => {
        const form = /<button[^>]*\sform="([^"]+)"/.exec(h)?.[1];
        if (form !== undefined) {
          const action = new RegExp(`<form id="${form}"[^>]*action="([^"]+)"`).exec(forms)?.[1];
          return [action === undefined ? `missing form ${form}` : `post ${action.replace(/\/\d+\//, "/N/")}`];
        }
        const href = /href="([^"]+)"/.exec(h)?.[1] ?? "";
        return href.includes("#comment-body") ? ["say"] : href.includes("/settings/") ? ["settings"] : [];
      });
      expect({ kind, reached: reached.filter((r) => r.startsWith("missing")) }).toEqual({ kind, reached: [] });
      expect({ kind, settles: SETTLES[kind].every((a) => reached.some((r) => r.includes(a))) }).toEqual({ kind, settles: true });
    }
  });

  test("an assigned pull offers Give to the crew and Close, and Land only when it is allowed", () => {
    const pull = work("pull", owner);
    const d = decisionsFor(ctx(), [repo], { evenDismissed: true }).find((x) => x.id === `assigned:${pull.id}`)!;
    expect(d.giveBack).toBe("builder");
    // No green check: landing is not allowed, so no Land button.
    expect(d.canLand).toBeUndefined();
    const text = (x: Decision) => {
      const { primary, others } = decisionButtons(ctx(), x);
      return [primary, ...others].map(String).join("");
    };
    expect(text(d)).toContain("Give to the crew");
    expect(text(d)).toContain("Close");
    expect(text(d)).not.toContain("Land");
    const landable = { ...d, canLand: true };
    expect(text(landable)).toContain("Land");
    const forms = String(decisionForm(landable));
    expect(forms).toContain("/asks/give-back");
    expect(forms).toContain(`/pulls/${pull.number}/ship`);
    expect(forms).toContain(`/pulls/${pull.number}/state`);
  });

  test("a pull with changes requested offers no Land; an assigned issue gives to the crew or closes", () => {
    const pull = work("pull", owner);
    changes(pull, new Date().toISOString());
    const issue = work("issue", owner);
    const all = decisionsFor(ctx(), [repo], { evenDismissed: true });
    expect(all.find((x) => x.id === `assigned:${pull.id}`)!.canLand).toBeUndefined();
    const d = all.find((x) => x.id === `assigned:${issue.id}`)!;
    const { primary, others } = decisionButtons(ctx(), d);
    const text = [primary, ...others].map(String).join("");
    expect(text).toContain("Give to the crew");
    expect(text).toContain("Close");
    expect(String(decisionForm(d))).toContain(`/issues/${issue.number}/state`);
    expect(giveBack(app, owner, `assigned:${issue.id}`).ok).toBe(true);
    expect(getIssueById(app.db, issue.id)!.assigneeId).toBe(builder.id);
  });

  test("a held pull with changes requested goes back to its builder after a day of silence, once", () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * DAY).toISOString();
    const stuck = work("pull", owner, old);
    changes(stuck, old);
    const fresh = work("pull", owner, old);
    changes(fresh, new Date(now.getTime() - DAY / 2).toISOString());
    const spoke = work("pull", owner, old);
    changes(spoke, old);
    app.db.query(`INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, 'on it', ?4)`)
      .run(id(), spoke.id, owner.id, new Date(now.getTime() - DAY / 2).toISOString());
    const plain = work("pull", owner, old);

    expect(sweepStranded(app, now)).toEqual([stuck.number]);
    expect(getIssueById(app.db, stuck.id)!.assigneeId).toBe(builder.id);
    for (const p of [fresh, spoke, plain]) expect(getIssueById(app.db, p.id)!.assigneeId).toBe(owner.id);
    const said = app.db.query<{ body: string }, [string]>("SELECT body FROM comment WHERE issue_id = ?1").all(stuck.id);
    expect(said.map((c) => c.body)).toContain(STRANDED_LINE);
    expect(sweepStranded(app, now)).toEqual([]);
  });
  test("an assigned card carries one accent: Land is a plain button beside a primary Give to the crew", () => {
    const pull = work("pull", owner);
    const d = { ...decisionsFor(ctx(), [repo], { evenDismissed: true }).find((x) => x.id === `assigned:${pull.id}`)!, canLand: true };
    const { primary, others } = decisionButtons(ctx(), d);
    expect(String(primary)).toContain("Give to the crew");
    const land = others.map(String).find((h) => h.includes("Land"))!;
    expect(land).toBeDefined();
    expect([primary, ...others].map(String).filter((h) => h.includes("primary")).length).toBe(1);
  });

  test("the batch read names the same crew member as the single read, for pulls and issues", () => {
    const rows = [work("pull", owner), work("issue", owner), work("pull", owner), work("issue", null)].map((w) => ({ repo, work: w }));
    const many = crewHandsFor(app.db, rows);
    for (const { work: w } of rows) expect(many.get(w.id)).toBe(crewHandFor(app.db, repo, w)?.username);
  });
  /** A finished check on the pull's head, newer than anything else on it. */
  const green = (pull: Issue) =>
    app.db.query(`INSERT INTO run (id, repo_id, kind, issue_id, env, commit_oid, branch, reason, state, created_at, finished_at) VALUES (?1, ?2, 'check', ?3, 'pull', ?4, 'b', '', 'ok', ?5, ?5)`)
      .run(id(), repo.id, pull.id, ZERO, new Date(Date.now() + 1000).toISOString());

  test("a green pull with no change asked of its head can land, read through the real path", () => {
    const pull = work("pull", owner);
    green(pull);
    const d = decisionsFor(ctx(), [repo], { evenDismissed: true }).find((x) => x.id === `assigned:${pull.id}`)!;
    expect(d.canLand).toBe(true);
  });

  test("a green pull with a change requested on its head cannot land", () => {
    const pull = work("pull", owner);
    green(pull);
    changes(pull, new Date().toISOString());
    // In an autonomous repository the crew looks at its own green pulls, so the person's card is the assignment.
    const own = { ...repo, autonomy: "autonomous" } as Repo;
    const d = decisionsFor(ctx(), [own], { evenDismissed: true }).find((x) => x.id === `assigned:${pull.id}`)!;
    expect(d.canLand).toBeUndefined();
  });

  test("a pull handed to a person just now keeps its day, however old the verdict", () => {
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    const pull = work("pull", null, old);
    changes(pull, old);
    expect(assignIssue(app, owner, repo, pull, owner).ok).toBe(true);
    expect(sweepStranded(app, new Date())).not.toContain(pull.number);
    expect(getIssueById(app.db, pull.id)!.assigneeId).toBe(owner.id);
    // A day after the hand-over, it goes back.
    expect(sweepStranded(app, new Date(Date.now() + DAY + 60_000))).toContain(pull.number);
  });

  test("a change asked of an older head strands nothing once the builder pushed again", () => {
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    const pull = work("pull", owner, old);
    changes(pull, old);
    app.db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(pull.id, "a".repeat(40));
    expect(sweepStranded(app, new Date())).not.toContain(pull.number);
    expect(getIssueById(app.db, pull.id)!.assigneeId).toBe(owner.id);
  });
});
