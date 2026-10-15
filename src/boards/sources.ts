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
   * its `issue_id` names. Every query is narrowed by this.
   */
  owner: "repo_id" | "issue";
  /** Fixed predicate narrowing the table to this source; no input in it. */
  where?: string;
  /** The column `from`, `to` and `{bucket}` apply to. */
  time: string;
  columns: Readonly<Record<string, ColumnType>>;
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
};
