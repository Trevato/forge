/**
 * The sources a board may query: each a forge table, its columns and their
 * types, and the one column that says when a row happened. A column that
 * holds a secret, a token or a sealed value is never listed, so no query
 * can name it. Table and column names are SQL identifiers taken from here
 * and nowhere else. Free text people type (a run's reason, a decision's
 * answer, branch names, an environment or app slug) is not listed either:
 * a board that groups by it would read it back out.
 */

export type ColumnType = "text" | "number" | "time";

export type Source = {
  table: string;
  /**
   * How a row belongs to a repo: its own `repo_id`, or through the issue
   * its `issue_id` names. Every query is narrowed by this. `admin` rows
   * belong to no repo (the machine itself): only a scope of every repo
   * reads them.
   */
  owner: "repo_id" | "issue" | "admin";
  /**
   * A fixed SELECT read in place of a table, named `table` inside the
   * query; no input in it. For a source that is a view over several tables.
   */
  select?: string;
  /** Fixed predicate narrowing the table to this source; no input in it. */
  where?: string;
  /** The column `from`, `to` and `{bucket}` apply to. */
  time: string;
  columns: Readonly<Record<string, ColumnType>>;
  /** What a column means, with its unit, where the name alone does not say. */
  docs?: Readonly<Record<string, string>>;
};

export const SOURCES: Readonly<Record<string, Source>> = {
  runs: {
    table: "run",
    owner: "repo_id",
    time: "created_at",
    columns: {
      id: "text", repo_id: "text", kind: "text", issue_id: "text",
      state: "text", actor_id: "text",
      subscription_id: "text", cost_usd: "number", turns: "number",
      attempt: "number", created_at: "time", started_at: "time", finished_at: "time",
    },
  },
  pulls: {
    table: "pull",
    owner: "issue",
    time: "merged_at",
    columns: {
      issue_id: "text", head_repo_id: "text", merged_by: "text", merged_at: "time",
    },
  },
  reviews: {
    table: "review",
    owner: "issue",
    time: "created_at",
    columns: {
      id: "text", issue_id: "text", author_id: "text", state: "text",
      created_at: "time",
    },
  },
  deploys: {
    table: "run",
    owner: "repo_id",
    where: "kind = 'deploy'",
    time: "created_at",
    columns: {
      id: "text", repo_id: "text", state: "text",
      actor_id: "text", cost_usd: "number", created_at: "time",
      started_at: "time", finished_at: "time", serving_at: "time",
    },
  },
  apps: {
    table: "app",
    owner: "repo_id",
    time: "created_at",
    columns: {
      id: "text", repo_id: "text", access: "text",
      preview_data: "text", created_at: "time",
    },
  },
  decisions: {
    table: "decision",
    owner: "repo_id",
    time: "created_at",
    columns: {
      id: "text", kind: "text", repo_id: "text", issue_id: "text", state: "text",
      p: "number", by: "text", ms: "number", outcome: "text",
      created_at: "time", outcome_at: "time",
    },
  },
  spend: {
    table: "usage",
    owner: "repo_id",
    time: "at",
    columns: {
      run_id: "text", repo_id: "text", issue_id: "text", agent_id: "text",
      subscription_id: "text", kind: "text", tokens_in: "number",
      tokens_out: "number", cost_usd: "number", wall_ms: "number",
      outcome: "text", at: "time",
    },
  },
  // Requests counted by the hour (`core/usage_count.ts`): admin only. `hour`
  // is `2026-10-16T13`, so `from` and `to` bound it by string and a bucket
  // cannot read it; group by a column instead.
  usage: {
    table: "usage_count",
    owner: "admin",
    time: "hour",
    columns: {
      hour: "time", pattern: "text", method: "text", status: "text",
      role: "text", surface: "text", n: "number",
    },
    docs: {
      hour: "the hour the requests were answered in, UTC, like 2026-10-16T13",
      pattern: "the route pattern that matched, or (unmatched) for every path that matched none",
      status: "the status class: 2xx, 3xx, 4xx or 5xx",
      role: "anon, user, admin or agent",
      surface: "api, mcp or web",
      n: "requests in that hour with that pattern, method, status class, role and surface",
    },
  },
  // Browser sign-ins: one row per session. The token hash and the session
  // id are not listed. Failed sign-ins are not a row anywhere; they are the
  // `usage` rows for POST /signin with a 4xx status.
  signins: {
    table: "session",
    owner: "admin",
    time: "created_at",
    columns: { user_id: "text", created_at: "time", expires_at: "time", last_seen_at: "time" },
  },
  // API tokens: scope, owner and age. The token text and its hash and name are not listed.
  tokens: {
    table: "token",
    owner: "admin",
    time: "created_at",
    columns: { id: "text", user_id: "text", scope: "text", created_at: "time", last_used_at: "time", expires_at: "time" },
    docs: { scope: "ro, rw or admin" },
  },
  // What admins did: the events an admin account appended. The payload is not listed.
  adminActions: {
    table: "event",
    owner: "admin",
    where: "actor_id IN (SELECT id FROM user WHERE is_admin = 1)",
    time: "created_at",
    columns: { id: "text", kind: "text", repo_id: "text", actor_id: "text", created_at: "time" },
  },
  // What the machine used (`boards/sampler.ts`, kept by `boards/ring.ts`):
  // 15-s points for the last day, 5-min points before that, never both
  // for one moment.
  machine: {
    table: "machine_sample",
    owner: "admin",
    where:
      "(step = 15 OR at <= COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(at), '-300 seconds') " +
      "FROM machine_sample WHERE step = 15), '9999'))",
    time: "at",
    columns: {
      target: "text", at: "time", step: "number",
      cpu_cores: "number", cpu_cores_max: "number",
      memory_bytes: "number", memory_bytes_max: "number", load: "number",
      celsius: "number", celsius_max: "number",
    },
    docs: {
      target:
        "forge (the pod), check:<run id>, app:<slug>/<env>, node, cpu:<nnn> (one logical CPU, zero-padded), " +
        "package:<id> or sensor:<chip>/<label> (a thermometer)",
      at: "when the point was read (15 s) or its window began (5 min), UTC",
      step: "seconds the point covers: 15, or 300 for a 5-min roll-up",
      cpu_cores: "cores in use, mean over the step (CPU seconds per second); at most 1 for a cpu:<nnn>",
      cpu_cores_max: "cores, the highest 15-s point in the step",
      memory_bytes: "bytes resident, mean over the step",
      memory_bytes_max: "bytes, the highest 15-s point in the step",
      load: "node only: the 1-min load average, runnable tasks",
      celsius: "°C, mean over the step: a cpu:<nnn>'s core, a package or a sensor; null for the rest",
      celsius_max: "°C, the highest 15-s point in the step",
    },
  },
  // Items entering each stage from issue to live, one row per entry, read
  // from issue, run and pull as `flow/throughput.ts` reads them: an issue
  // opens, a builder first starts on it (a retry is not a second item), its
  // pull opens, the pull merges into the default branch, a production
  // deploy serves. The stage names are numbered so they sort in that order.
  stages: {
    table: "stage",
    owner: "repo_id",
    select:
      "SELECT '1 issue' AS stage, repo_id, id AS issue_id, created_at AS at FROM issue WHERE kind = 'issue' " +
      "UNION ALL SELECT '2 run', x.repo_id, x.issue_id, MIN(x.started_at) FROM run x JOIN issue i ON i.id = x.issue_id " +
      "WHERE x.kind = 'agent' AND x.reason != 'review' AND i.kind = 'issue' AND x.started_at IS NOT NULL GROUP BY x.issue_id " +
      "UNION ALL SELECT '3 pull', i.repo_id, i.id, i.created_at FROM issue i JOIN pull p ON p.issue_id = i.id " +
      "UNION ALL SELECT '4 merged', i.repo_id, i.id, p.merged_at FROM pull p JOIN issue i ON i.id = p.issue_id " +
      "JOIN repo r ON r.id = i.repo_id WHERE p.merged_at IS NOT NULL AND p.base_branch = r.default_branch " +
      "UNION ALL SELECT '5 live', repo_id, NULL, serving_at FROM run " +
      "WHERE kind = 'deploy' AND env = 'production' AND serving_at IS NOT NULL",
    time: "at",
    columns: { stage: "text", repo_id: "text", issue_id: "text", at: "time" },
    docs: {
      stage:
        "1 issue (opened), 2 run (a builder first started on the issue), 3 pull (opened), " +
        "4 merged (into the default branch) or 5 live (a production deploy served)",
      issue_id: "the issue or pull that entered; null for 5 live, which is a deploy",
      at: "when the item entered the stage, UTC",
    },
  },
};
