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

const DAY_AT = "day || 'T00:00:00.000Z'";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Nearest-rank percentile `p` of a page_vital column, per route per day, as rows of the `reach` source. */
const percentile = (name: string, column: string, p: number) =>
  `SELECT '${name}' AS metric, route, ${DAY_AT} AS at, ${column} AS value FROM (` +
  `SELECT route, day, ${column}, ROW_NUMBER() OVER (PARTITION BY route, day ORDER BY ${column}) AS rn, ` +
  `COUNT(*) OVER (PARTITION BY route, day) AS n FROM page_vital WHERE ${column} IS NOT NULL) ` +
  `WHERE rn = (n * ${p} + 99) / 100`;

/** The budget a spawned forge has to answer its `/healthz`: three minutes (#2914). */
export const SPAWN_BUDGET_MS = 180_000;

/** A spawn event's payload fields, as a drill or a person's forge, read in place of the `event` table. */
const SPAWN_SERIES = "CASE WHEN json_extract(payload, '$.drill') = 1 THEN 'drill' ELSE 'forge' END";
const SPAWN_KINDS = "kind IN ('forge.spawn.started', 'forge.spawn.live', 'forge.spawn.failed')";
const SPAWN_DAY = "substr(created_at, 1, 10) || 'T00:00:00.000Z'";

/** Nearest-rank percentile `p` of the ms to live, per series per day, as rows of the `spawnTime` source. */
const spawnPercentile = (name: string, p: number) =>
  `SELECT '${name}' AS metric, series, at, ms AS value FROM (` +
  `SELECT ${SPAWN_SERIES} AS series, ${SPAWN_DAY} AS at, json_extract(payload, '$.ms') AS ms, ` +
  `ROW_NUMBER() OVER (PARTITION BY ${SPAWN_SERIES}, ${SPAWN_DAY} ORDER BY json_extract(payload, '$.ms')) AS rn, ` +
  `COUNT(*) OVER (PARTITION BY ${SPAWN_SERIES}, ${SPAWN_DAY}) AS n ` +
  `FROM event WHERE kind = 'forge.spawn.live' AND json_extract(payload, '$.ms') IS NOT NULL) ` +
  `WHERE rn = (n * ${p} + 99) / 100`;

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
  // One row per awake interval of an app environment (`core/meter.ts`): it
  // wakes when the row begins and sleeps when it ends, so the two are two
  // sources over one table, each timed by its own edge.
  wakes: {
    table: "meter",
    owner: "repo_id",
    time: "started_at",
    columns: { repo_id: "text", placement: "text", started_at: "time", ended_at: "time" },
  },
  sleeps: {
    table: "meter",
    owner: "repo_id",
    where: "ended_at IS NOT NULL",
    time: "ended_at",
    columns: { repo_id: "text", placement: "text", started_at: "time", ended_at: "time" },
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
      lag_ms: "number", lag_ms_max: "number", checks: "number", agents: "number",
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
      lag_ms:
        "forge only: how late its event loop woke, ms, 99th percentile over the 15 s; a 5-min point is the mean of its 15-s points",
      lag_ms_max: "forge only: ms, the highest 15-s point in the step",
      checks: "forge only: checks running at the instant; a 5-min point is the mean",
      agents: "forge only: crew runs running at the instant; a 5-min point is the mean",
    },
  },
  // Who visits and how fast it is (#2712): one row per metric (and route, and
  // day), read from the page-view beacon's `page_vital` and from `session`.
  // Admin only. The visitor hash and the user ids are not listed.
  reach: {
    table: "reach",
    owner: "admin",
    select: [
      `SELECT 'visitors' AS metric, '' AS route, ${DAY_AT} AS at, COUNT(DISTINCT visitor) AS value FROM page_vital GROUP BY day`,
      percentile("load_p75", "load", 75),
      percentile("lcp_p75", "lcp", 75),
      percentile("inp_p75", "inp", 75),
      percentile("cls_p75", "cls", 75),
      percentile("ttfb_p75", "ttfb", 75),
      percentile("server_p50", "ttfb", 50),
      percentile("server_p95", "ttfb", 95),
      `SELECT 'accounts_active_1d', '', ${NOW}, COUNT(DISTINCT user_id) FROM session WHERE last_seen_at >= strftime('%Y-%m-%dT00:00:00Z', 'now')`,
      `SELECT 'accounts_active_7d', '', ${NOW}, COUNT(DISTINCT user_id) FROM session WHERE last_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`,
      `SELECT 'accounts_total', '', ${NOW}, COUNT(*) FROM user`,
    ].join(" UNION ALL "),
    time: "at",
    columns: { metric: "text", route: "text", at: "time", value: "number" },
    docs: {
      metric:
        "visitors (distinct browsers that day), load_p75 (page load), lcp_p75 and inp_p75 (ms), cls_p75 (layout shift, unitless score, not ms), " +
        "ttfb_p75, server_p50 and server_p95 (ms, time to first byte), accounts_active_1d (signed in today), accounts_active_7d, accounts_total",
      route: "the route pattern, never the path; empty for visitors and accounts",
      at: "the day (UTC) for visitors and the percentiles; now for the account counts, which are not kept per day",
      value: "the count, or the percentile (nearest rank) of that route that day",
    },
  },
  // What each app's visitors report (`apps/vitals.ts`): one row per app per
  // day, filed under the app's repo, so a scope of the repos someone
  // administers (as the app's settings card decides) is the only gate. The
  // visitor hash and the slug are not listed.
  app_vital: {
    table: "app_vital_day",
    owner: "repo_id",
    select:
      "SELECT a.repo_id AS repo_id, v.app_id AS app, v.day || 'T00:00:00.000Z' AS day, " +
      "MAX(CASE WHEN v.load IS NOT NULL AND v.rl = (v.nl * 75 + 99) / 100 THEN v.load END) AS load_p75, " +
      "MAX(CASE WHEN v.inp IS NOT NULL AND v.ri = (v.ni * 75 + 99) / 100 THEN v.inp END) AS inp_p75, " +
      "COUNT(*) AS reports FROM (SELECT app_id, day, load, inp, " +
      "ROW_NUMBER() OVER (PARTITION BY app_id, day ORDER BY load IS NULL, load) AS rl, " +
      "COUNT(load) OVER (PARTITION BY app_id, day) AS nl, " +
      "ROW_NUMBER() OVER (PARTITION BY app_id, day ORDER BY inp IS NULL, inp) AS ri, " +
      "COUNT(inp) OVER (PARTITION BY app_id, day) AS ni FROM app_vital) v " +
      "JOIN app a ON a.id = v.app_id GROUP BY v.app_id, v.day",
    time: "day",
    columns: { repo_id: "text", app: "text", day: "time", load_p75: "number", inp_p75: "number", reports: "number" },
    docs: {
      app: "the app's id",
      day: "the day (UTC)",
      load_p75: "page load, ms, nearest-rank 75th percentile of that day's reports; null with none",
      inp_p75: "interaction to next paint, ms, same rank; null with none",
      reports: "reports kept that day (production only)",
    },
  },
  // The release keeper's releases (#7557), one row each: what the probes
  // counted through the roll and the ten minutes under page load. Seconds
  // dark is the target-zero number. The stop reason is free text, not listed.
  keeperReleases: {
    table: "keeper_release",
    owner: "admin",
    time: "cut_at",
    columns: {
      version: "text", stage: "text", cut_at: "time", live_at: "time", finished_at: "time",
      roll_probes: "number", roll_non200: "number", probes: "number", pages: "number",
      bad_in_row: "number", worst_ms: "number", seconds_dark: "number",
    },
    docs: {
      stage: "rolling, verifying, verified (verified live) or rolled_back",
      roll_non200: "/healthz probes, one a second, that got no 200 while the roll ran (target 0 with surge)",
      probes: "/healthz probes in the ten minutes under page load",
      pages: "pages fetched as an admin under load, one at a time",
      bad_in_row: "the most bad probes in a row (non-200 or over 10 s); 3 fails the release",
      worst_ms: "the slowest probe or page, ms",
      seconds_dark: "probe-seconds with no 200, roll and verify together (target 0)",
    },
  },
  // Forges made by the one-click path (#2914): one row per spawn event
  // (`actions/spawn.ts`, `spawn/live.ts`). The forge's name and the failure's
  // words are not listed; the step is one of a fixed few.
  spawns: {
    table: "spawn",
    owner: "admin",
    select:
      `SELECT substr(kind, 13) AS outcome, ${SPAWN_SERIES} AS series, json_extract(payload, '$.step') AS step, ` +
      `json_extract(payload, '$.ms') AS ms, created_at AS at FROM event WHERE ${SPAWN_KINDS}`,
    time: "at",
    columns: { outcome: "text", series: "text", step: "text", ms: "number", at: "time" },
    docs: {
      outcome: "started, live (its /healthz first answered) or failed",
      series: "forge (a person's) or drill (the nightly drill's own forge)",
      step: "failed only: place, copy or health",
      ms: "live only: milliseconds from started to the first /healthz answer",
    },
  },
  // Time to live per day: p50 and p95 of the spawns that went live, and the
  // budget as a third row so a line chart shows the margin.
  spawnTime: {
    table: "spawn_time",
    owner: "admin",
    select: [
      spawnPercentile("p50", 50),
      spawnPercentile("p95", 95),
      `SELECT 'budget', series, at, ${SPAWN_BUDGET_MS} FROM (SELECT DISTINCT ${SPAWN_SERIES} AS series, ${SPAWN_DAY} AS at ` +
        `FROM event WHERE ${SPAWN_KINDS})`,
    ].join(" UNION ALL "),
    time: "at",
    columns: { metric: "text", series: "text", at: "time", value: "number" },
    docs: {
      metric: "p50 or p95 (nearest rank) of the ms to live that day, or budget",
      series: "forge (a person's) or drill (the nightly drill's own forge)",
      at: "the day, UTC",
      value: "milliseconds; the budget is 180000 (three minutes)",
    },
  },
  // Every time an app's production process was started again over one that
  // served (#4496), from its deploy runs: one row per deploy that came to
  // serve, timed by that instant, with why — the reason a deploy carries,
  // mapped to four fixed words. A wake from sleep is not a restart: nothing
  // was serving to be interrupted.
  restarts: {
    table: "restart",
    owner: "repo_id",
    select:
      "SELECT repo_id, serving_at AS at, CASE reason WHEN 'boot' THEN 'forge roll' WHEN 'restart' THEN 'crash' " +
      "WHEN 'oom' THEN 'oom' ELSE 'own deploy' END AS cause FROM run " +
      "WHERE kind = 'deploy' AND env = 'production' AND serving_at IS NOT NULL AND reason NOT IN ('wake', 'enabled')",
    time: "at",
    columns: { repo_id: "text", cause: "text", at: "time" },
    docs: {
      cause:
        "own deploy (a push, a merge, a redeploy), forge roll (the forge itself restarted: a release, " +
        "and also a crash or eviction of the forge, which its deploys cannot tell apart), " +
        "crash (the process exited and was started again) or oom (over its memory cap, by its cell's watch or the kernel)",
      at: "when the new process began serving, UTC",
    },
  },
  // Red batches the merge queue named (#7639): a pull handed back, or a load red no pull is blamed for.
  queueVerdicts: {
    table: "queue_verdict",
    owner: "repo_id",
    time: "at",
    columns: { repo_id: "text", kind: "text", why: "text", pull_number: "number", action: "text", at: "time" },
    docs: {
      kind: "real (one pull named and returned to its builder) or load (the machine's red, no pull blamed)",
      why: "tests, typecheck, check, install, setup, timeout or flake",
      action: "what was done about it, in a fixed phrase",
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
