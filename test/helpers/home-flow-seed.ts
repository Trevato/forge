/**
 * A forge with work in every lane of the new home (`web/pages/home_flow.ts`):
 * asks ready for a builder, builds running and waiting, checks running and
 * waiting, reviews, approved pulls and merged ones on their way, and releases
 * that went live. Rows are written straight into the tables, the way the
 * other flow fixtures do, so a suite or a screenshot builds it in
 * milliseconds. `move` shifts one pull to the next lane, as the crew would.
 */
import type { App } from "../../src/app.ts";
import { createRepo } from "../../src/actions/repos.ts";
import { createIssue } from "../../src/core/issues.ts";
import { createUser, type User } from "../../src/core/users.ts";
import { promote } from "./members.ts";

const MIN = 60_000;
const ago = (minutes: number): string =>
  new Date(Date.now() - minutes * MIN).toISOString();

export interface HomeFlowSeed {
  readonly owner: User;
  readonly repos: Record<
    "forge" | "glue" | "notes",
    { readonly id: string; readonly name: string }
  >;
  /** Pull issue ids by a short name, to move or look for. */
  readonly pulls: Record<string, string>;
  /** Issue ids by a short name. */
  readonly issues: Record<string, string>;
}

async function person(
  app: App,
  username: string,
  first = false,
): Promise<User> {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    allowReserved: true,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: first,
  });
  if (!made.ok) throw new Error(made.error);
  promote(app.db, made.value);
  return made.value;
}

export async function seedHomeFlow(app: App): Promise<HomeFlowSeed> {
  const db = app.db;
  const owner = await person(app, "trevato", true);
  const scout = await person(app, "scout");
  const torque = await person(app, "torque");
  const reviewer = await person(app, "ledger");
  const repos = {} as Record<
    "forge" | "glue" | "notes",
    { id: string; name: string }
  >;
  for (const [name, visibility] of [
    ["forge", "public"],
    ["glue", "private"],
    ["notes", "public"],
  ] as const) {
    const made = await createRepo(app, owner, { name, visibility });
    if (!made.ok) throw new Error(made.error);
    repos[name] = { id: made.value.id, name };
    db.run(
      "UPDATE repo SET autonomy = 'autonomous', autonomy_slots = 4 WHERE id = ?1",
      [made.value.id],
    );
    db.run(
      "INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, ?3, 'public')",
      [`app-${name}`, made.value.id, name],
    );
  }
  const issues: Record<string, string> = {};
  const pulls: Record<string, string> = {};
  const ask = (
    repo: keyof typeof repos,
    key: string,
    title: string,
    at = 5,
  ): string => {
    const made = createIssue(db, {
      repoId: repos[repo].id,
      authorId: owner.id,
      title,
      kind: "issue",
    });
    if (!made.ok) throw new Error(made.error);
    db.run("UPDATE issue SET created_at = ?2 WHERE id = ?1", [
      made.value.id,
      ago(at),
    ]);
    issues[key] = made.value.id;
    return made.value.id;
  };
  const pull = (
    repo: keyof typeof repos,
    key: string,
    title: string,
    head: string,
  ): string => {
    const made = createIssue(db, {
      repoId: repos[repo].id,
      authorId: scout.id,
      title,
      kind: "pull",
    });
    if (!made.ok) throw new Error(made.error);
    db.run(
      "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, 'base', 'head')",
      [made.value.id, head],
    );
    pulls[key] = made.value.id;
    return made.value.id;
  };
  let run = 0;
  const addRun = (r: {
    repo: keyof typeof repos;
    kind: "agent" | "check" | "deploy";
    issue?: string | null;
    state: "queued" | "running" | "ok";
    actor?: User | null;
    reason?: string;
    env?: string;
    at: number;
    beat?: number;
    serving?: number;
  }): string => {
    const id = `run-home-${++run}`;
    db.run(
      `INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, actor_id, reason, env, created_at, started_at, heartbeat_at, serving_at, finished_at)
       VALUES (?1, ?2, ?3, ?4, 'c0ffee1', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      [
        id,
        repos[r.repo].id,
        r.kind,
        r.issue ?? null,
        r.state,
        r.actor?.id ?? null,
        r.reason ?? "",
        r.env ?? "",
        ago(r.at),
        r.state === "queued" ? null : ago(r.at),
        r.beat === undefined ? null : ago(r.beat),
        r.serving === undefined ? null : ago(r.serving),
        r.state === "ok" ? ago(Math.max(0, r.at - 1)) : null,
      ],
    );
    return id;
  };

  // Asked: ready, nobody has them.
  ask(
    "forge",
    "ask1",
    "Show each lane's oldest waiting item on the home screen",
    190,
  );
  ask("glue", "ask2", "Let a pasted link open a note in the right app", 75);
  ask("notes", "ask3", "Search notes by the day they were written", 20);
  ask("forge", "ask4", "Tell the owner in words why a build is waiting", 9);

  // Building: three running, one waiting.
  const b1 = ask(
    "forge",
    "b1",
    "A cost ledger per delivery: tokens, compute and time",
    40,
  );
  const b2 = ask(
    "glue",
    "b2",
    "Retry a failed webhook with a longer pause each time",
    22,
  );
  const b3 = ask(
    "notes",
    "b3",
    "Keep a draft when the page is closed by accident",
    7,
  );
  const b4 = ask(
    "forge",
    "b4",
    "Make the release journey proof show its three screens",
    12,
  );
  addRun({
    repo: "forge",
    kind: "agent",
    issue: b1,
    state: "running",
    actor: scout,
    reason: "assigned",
    at: 14,
    beat: 0,
  });
  addRun({
    repo: "glue",
    kind: "agent",
    issue: b2,
    state: "running",
    actor: torque,
    reason: "check_failed",
    at: 6,
    beat: 0,
  });
  addRun({
    repo: "notes",
    kind: "agent",
    issue: b3,
    state: "running",
    actor: scout,
    reason: "assigned",
    at: 1,
    beat: 0,
  });
  addRun({
    repo: "forge",
    kind: "agent",
    issue: b4,
    state: "queued",
    actor: torque,
    reason: "assigned",
    at: 3,
  });

  // Checks: two running, two waiting.
  const c1 = pull(
    "forge",
    "c1",
    "The pipeline page tells a stuck lane from a busy one",
    "crew/c1",
  );
  const c2 = pull(
    "glue",
    "c2",
    "Retry pauses double up to ten minutes",
    "crew/c2",
  );
  const c3 = pull("notes", "c3", "Drafts survive a closed tab", "crew/c3");
  const c4 = pull(
    "forge",
    "c4",
    "A lane shows the oldest waiting item",
    "crew/c4",
  );
  addRun({ repo: "forge", kind: "check", issue: c1, state: "running", at: 4 });
  addRun({ repo: "glue", kind: "check", issue: c2, state: "running", at: 2 });
  addRun({ repo: "notes", kind: "check", issue: c3, state: "queued", at: 2 });
  addRun({ repo: "forge", kind: "check", issue: c4, state: "queued", at: 1 });

  // Review: one being read, one waiting.
  const r1 = pull(
    "forge",
    "r1",
    "Show a hosted forge's state in one line",
    "crew/r1",
  );
  const r2 = pull("notes", "r2", "The notes list opens on today", "crew/r2");
  addRun({
    repo: "forge",
    kind: "agent",
    issue: r1,
    state: "running",
    actor: reviewer,
    reason: "review",
    at: 5,
    beat: 0,
  });
  addRun({
    repo: "notes",
    kind: "agent",
    issue: r2,
    state: "queued",
    actor: reviewer,
    reason: "review",
    at: 2,
  });

  // Landing: two approved and waiting for a person, one merged and not yet live.
  const a1 = pull(
    "forge",
    "a1",
    "A failed proof is the one line that needs you",
    "crew/a1",
  );
  const a2 = pull("glue", "a2", "Pasted links keep their address", "crew/a2");
  for (const [issue, minutes] of [
    [a1, 95],
    [a2, 31],
  ] as const)
    db.run(
      "INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, 'approved', ?4)",
      [`rv-${issue}`, issue, reviewer.id, ago(minutes)],
    );
  const m1 = pull("notes", "m1", "Search finds a note by its day", "crew/m1");
  db.run(
    "UPDATE pull SET merged_at = ?2, merged_by = ?3, merged_oid = 'm1oid' WHERE issue_id = ?1",
    [m1, ago(3), owner.id],
  );

  // Live: two releases in the last day, each carrying a change.
  const l1 = pull(
    "forge",
    "l1",
    "The merge queue says why it is waiting",
    "crew/l1",
  );
  const l2 = pull(
    "glue",
    "l2",
    "Webhook deliveries are listed with their answers",
    "crew/l2",
  );
  for (const [issue, repo, minutes] of [
    [l1, "forge", 42],
    [l2, "glue", 380],
  ] as const) {
    db.run(
      "UPDATE pull SET merged_at = ?2, merged_by = ?3, merged_oid = 'l-oid' WHERE issue_id = ?1",
      [issue, ago(minutes + 2), owner.id],
    );
    const deploy = addRun({
      repo,
      kind: "deploy",
      state: "ok",
      env: "production",
      at: minutes + 1,
      serving: minutes,
      actor: owner,
    });
    db.run(
      "INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1, ?2, ?3, 'l-oid')",
      [deploy, issue, 1],
    );
  }
  return { owner, repos, pulls, issues };
}

/** Move one pull from where it is to the check queue's head: the crew starting its checks. */
export function startCheck(app: App, pull: string, repoId: string): void {
  app.db.run(
    `INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, created_at, started_at)
     VALUES (?1, ?2, 'check', ?3, 'c0ffee2', 'running', ?4, ?4)`,
    [`run-moved-${pull}`, repoId, pull, new Date().toISOString()],
  );
}
