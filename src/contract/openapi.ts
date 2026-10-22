/**
 * The forge's public API as an OpenAPI 3.1 document: the routes the
 * manifest (`actions/here.ts`) names to an agent, one row each, so a client
 * that reads OpenAPI (OpenCode's Code Mode, any agent harness) can call the
 * forge without a hand-written wrapper. Plain data in, plain data out;
 * `GET /contract/openapi.json` serves it. A route added to the manifest is
 * added here, and `test/openapi.test.ts` fails until it is.
 */

interface Route {
  readonly method: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly summary: string;
  /** Whether it needs a token; reads of public things do not. */
  readonly auth: boolean;
  /** A JSON body's fields, when it takes one. */
  readonly body?: Readonly<Record<string, string>>;
  /** The query parameters its handler reads, by name and type. */
  readonly query?: Readonly<Record<string, string>>;
  /** The success status, when it is not 200. */
  readonly status?: number;
  /** The refusals it answers, by stable `error` code. */
  readonly refusals?: Readonly<Record<string, string>>;
}

/** What `listQuery` in `http/api.ts` reads from a list of issues or pulls. */
const LIST_QUERY = { state: "string", limit: "integer", cursor: "integer", label: "string", author: "string" };

/** What `POST /api/v1/apps` reads from its body, and the refusals it answers. */
const APP_BODY = { name: "string", owner: "string", description: "string", visibility: "string", agent: "string", pick: "boolean" };
const APP_REFUSALS = {
  unverified: "the account has not verified its email",
  app_limit: "the owner is at the app limit",
  no_such_agent: "`agent` names no one on the crew",
  slug_taken: "another app already has this name's slug",
  name_taken: "the owner already has a repository of this name",
};

const REPO = "/api/v1/repos/{owner}/{name}";

export const ROUTES: readonly Route[] = [
  { method: "get", path: "/api/v1/apps", summary: "List the apps whose repositories you can read; answers { items, next_cursor }", auth: false },
  {
    method: "post",
    path: "/api/v1/apps",
    summary: "Make an app: a repository, its app and a first issue; answers 201 with { repo, app, issue }",
    auth: true,
    status: 201,
    body: APP_BODY,
    refusals: APP_REFUSALS,
  },
  {
    method: "get",
    path: "/api/v1/admin/accounts",
    summary:
      "List every person and agent, newest first (a forge admin's, read scope; anyone else gets 404); answers { items: [{ username, kind, displayName, isAdmin, createdAt, via, signsInThrough, address, repos, apps, spentUsd, suspendedAt, removedAt, verified }] }",
    auth: true,
  },
  {
    method: "delete",
    path: "/api/v1/admin/accounts/{username}",
    summary:
      "Remove an account for good (an admin's, admin scope); answers { removed }. With retireOrgs true and no confirm it answers { confirm_required, retire, own } and removes nothing; with both it retires the organizations the person solely owns and answers { removed, retired }, or 500 { error: \"delete_failed\", failed, removed }",
    auth: true,
    body: { retireOrgs: "boolean", confirm: "boolean" },
    refusals: {
      not_allowed: "an admin cannot remove themselves, another admin or an agent (422)",
      last_owner: "the person is the only one owning an organization (409)",
    },
  },
  {
    method: "post",
    path: "/api/v1/admin/accounts/{username}/role",
    summary: "Make a person a member (with an optional starter allowance in dollars a month) or a guest again (admin scope); answers the new role",
    auth: true,
    body: { role: "string", usdPerMonth: "number" },
    refusals: {
      invalid: "`role` is not member or guest, or `usdPerMonth` is not from 0.01 to 10000 dollars (422)",
      not_allowed: "the person is an admin (422)",
    },
  },
  {
    method: "post",
    path: "/api/v1/admin/accounts/{username}/ceiling",
    summary: "Set an account's daily and per-run model spend ceilings in dollars, both null to take them back (admin scope); answers the ceilings",
    auth: true,
    body: { dailyUsd: "number", perRunUsd: "number" },
    refusals: { invalid: "an amount is not null or from 0.01 to 10000 dollars (422)" },
  },
  {
    method: "post",
    path: "/api/v1/admin/accounts/{username}/model-grant",
    summary: "Grant a person a capped model allowance in dollars a month; null or 0 takes it back (admin scope); answers the grant",
    auth: true,
    body: { usdPerMonth: "number" },
    refusals: {
      invalid: "`usdPerMonth` is not null or from 0.01 to 10000 dollars (422)",
      not_allowed: "the person is an admin (422)",
    },
  },
  {
    method: "post",
    path: "/api/v1/admin/accounts/{username}/suspend",
    summary: "Suspend an account, undone by unsuspend (admin scope); answers { username, suspendedAt }",
    auth: true,
    body: { confirm: "boolean" },
    refusals: {
      not_allowed: "an admin cannot suspend themselves, another admin or an agent (422)",
      last_owner: "the person is the only active owner of an organization; send confirm true to suspend anyway (409)",
    },
  },
  {
    method: "post",
    path: "/api/v1/admin/accounts/{username}/unsuspend",
    summary: "Lift an account's suspension (admin scope); answers { username, suspendedAt: null }",
    auth: true,
    refusals: { not_allowed: "the target is an admin, an agent or yourself (422)" },
  },
  {
    method: "post",
    path: "/api/v1/admin/accounts/{username}/verify",
    summary: "Mark an account's email verified by hand (admin scope); answers { username, verified: true }",
    auth: true,
    refusals: { not_allowed: "the target is an admin, an agent or yourself (422)" },
  },
  {
    method: "get",
    path: "/api/v1/admin/invites",
    summary: "List invite links without their tokens (an admin's, read scope); answers { items }",
    auth: true,
  },
  {
    method: "post",
    path: "/api/v1/admin/invites",
    summary:
      "Mint an invite link (admin scope); answers 201 with the invite and its `token` and `link`: the link is shown once, here, and cannot be read again, so keep it",
    auth: true,
    status: 201,
    body: { days: "integer" },
    refusals: { invalid: "`days` is not a whole number from 1 to 30 (422)" },
  },
  {
    method: "delete",
    path: "/api/v1/admin/invites/{id}",
    summary: "Revoke an invite link by id (admin scope); 404 when there is none",
    auth: true,
  },
  { method: "get", path: "/api/v1/explore", summary: "Explore apps and repositories; `q` takes words and `kind:`/`owner:` filters; answers { query, items }", auth: false, query: { q: "string" } },
  { method: "get", path: "/api/v1/search", summary: "Search issues, pulls, repositories and code; `kind` narrows it", auth: false, query: { q: "string", kind: "string" } },
  { method: "get", path: "/api/v1/repos", summary: "List public repositories", auth: false },
  {
    method: "get",
    path: REPO,
    summary:
      "Read one repository; `provenance` is where a migrated one came from ({ source, sourceUrl, parents: [{ fullName, url }], migratedAt }), null when it was not migrated or its owner hid it",
    auth: false,
  },
  {
    method: "post",
    path: `${REPO}/reports`,
    summary: "Report a problem in a public repository, without an account",
    auth: false,
    body: { title: "string", body: "string", page: "string" },
  },
  {
    method: "get",
    path: "/api/v1/admin/settings",
    summary:
      "Read the forge's signup mode and account quotas (a person admin's token, any scope); answers { quotas, signup, signupChanges, changes }",
    auth: true,
    refusals: { not_found: "the token is not a person who administers the forge" },
  },
  {
    method: "patch",
    path: "/api/v1/admin/settings",
    summary:
      "Change the signup mode (open, invite or closed) or the account quotas, one of the two per call (a person admin's token, admin scope); answers { signup } or { quotas }; a quota is a positive whole number, or null for no limit",
    auth: true,
    body: { signup: "string", quotas: "object" },
    refusals: {
      invalid_body: "neither signup nor quotas was sent, or both were",
      invalid_signup: "signup is not open, invite or closed",
      no_such_quota: "a quota key is unknown",
      invalid_quota: "a quota is not a positive whole number or null",
      not_found: "the token is not a person who administers the forge",
    },
  },
  {
    method: "get",
    path: "/api/v1/admin/limits",
    summary:
      "Read the forge's limits (a person admin's token, any scope); answers { limits: [{ key, value, isSet, defaultValue, ... }], changes }",
    auth: true,
    refusals: { not_found: "the token is not a person who administers the forge" },
  },
  {
    method: "get",
    path: "/api/v1/admin/capacity",
    summary:
      "Read the forge's capacity settings (a person admin's token, any scope); answers { settings: [{ key, label, help, value, source, default, env, changed? }], changes }",
    auth: true,
    refusals: { not_found: "the token is not a person who administers the forge" },
  },
  {
    method: "get",
    path: "/api/v1/admin/teams",
    summary:
      "Read the crew's teams (a person admin's token, any scope); answers { teams: [{ slug, charter, dial, members, ... }] }",
    auth: true,
    refusals: { not_found: "the token is not a person who administers the forge" },
  },
  {
    method: "get",
    path: "/api/v1/admin/people",
    summary:
      "List every person and their role (admin scope); answers { people: [{ username, role, usdPerMonth }] }, role being admin, member or guest",
    auth: true,
  },
  { method: "get", path: `${REPO}/issues`, summary: "List a repository's issues; fields=brief leaves out bodies and comments, any other fields value is a 422 invalid_fields", auth: false, query: { ...LIST_QUERY, fields: "string" } },
  { method: "get", path: `${REPO}/pulls`, summary: "List a repository's pulls", auth: false, query: LIST_QUERY },
  {
    method: "post",
    path: `${REPO}/issues`,
    summary: "Open an issue",
    auth: true,
    body: { title: "string", body: "string" },
  },
  { method: "get", path: `${REPO}/issues/{number}`, summary: "Read one issue with its comments; comments=N (0 to 200) answers only the newest N and commentCount, any other value is a 422 invalid_comments", auth: false, query: { comments: "integer" } },
  {
    method: "patch",
    path: `${REPO}/issues/{number}`,
    summary: "Close or reopen an issue (state, with a reason and the issue it went into)",
    auth: true,
    body: { state: "string", reason: "string", into: "integer" },
  },
  {
    method: "get",
    path: "/api/v1/secrets/{scope}",
    summary: "List a scope's secret names and timestamps, never a value; admin only; `ref` names an org or `owner/name`, the forge scope takes none; answers { items, next_cursor }",
    auth: true,
    query: { ref: "string" },
    refusals: { not_found: "the scope's owner is unknown", invalid_scope: "the scope is not one the forge keeps secrets for" },
  },
  {
    method: "delete",
    path: "/api/v1/secrets/{scope}/{name}",
    summary: "Remove a secret by name (admin scope token); a value is never read back; answers {}",
    auth: true,
    query: { ref: "string" },
    refusals: { not_found: "no such secret or scope owner", invalid_scope: "the scope is not one the forge keeps secrets for" },
  },
  {
    method: "get",
    path: "/api/v1/tokens",
    summary: "List your own tokens; a bearer token is refused with 403, call it from a browser session or with a password",
    auth: false,
    refusals: { forbidden: "the caller holds a bearer token, which cannot manage tokens" },
  },
  {
    method: "post",
    path: "/api/v1/tokens",
    summary: "Mint a token of scope ro, rw or admin; needs a browser session or a username and password, a bearer token is refused with 403; a site admin must send adminConfirm: true; answers 201 with the token once",
    auth: false,
    status: 201,
    body: { name: "string", scope: "string", username: "string", password: "string", adminConfirm: "boolean" },
    refusals: {
      invalid_scope: "scope is not ro, rw or admin",
      admin_confirm: "a site admin did not send adminConfirm: true",
      forbidden: "a bearer token cannot mint tokens, or the account may not hold an admin token",
    },
  },
  {
    method: "delete",
    path: "/api/v1/tokens/{id}",
    summary: "Revoke one of your tokens; a bearer token is refused with 403, call it from a browser session or with a password; answers 204",
    auth: false,
    status: 204,
    refusals: { forbidden: "the caller holds a bearer token, which cannot manage tokens" },
  },
  {
    method: "post",
    path: "/api/v1/sessions",
    summary: "Sign in with a username and password; sets the HttpOnly session cookie and answers 201 with the user; same-origin only, throttled; not for a bearer token",
    auth: false,
    status: 201,
    body: { username: "string", password: "string" },
    refusals: { too_large: "the body is over the limit", too_many_attempts: "sign-in is throttled; retry-after says when" },
  },
  {
    method: "delete",
    path: "/api/v1/sessions",
    summary: "Sign out the browser session and clear its cookie; same-origin only; a bearer token has no session to end; answers {}",
    auth: false,
  },
  { method: "get", path: "/api/v1/telemetry/system", summary: "Read the forge's system view; the owner or an agent holding telemetry:read, with a ro token; every agent read is logged", auth: true },
  { method: "get", path: "/api/v1/telemetry/flow", summary: "Read the forge's flow view; the owner or an agent holding telemetry:read, with a ro token; every agent read is logged", auth: true },
  { method: "get", path: "/api/v1/telemetry/sources", summary: "List telemetry sources; answers { sources }; the owner or an agent holding telemetry:read", auth: true },
  { method: "get", path: "/api/v1/telemetry/history", summary: "Read telemetry history; answers { points }; the owner or an agent holding telemetry:read", auth: true },
  { method: "get", path: `${REPO}/pulls/{number}`, summary: "Read one pull with its diff and review gate (diff=0 leaves the diff out)", auth: false, query: { diff: "string" } },
  { method: "get", path: `${REPO}/issues/{number}/comments`, summary: "Page through an issue's or pull's comments, oldest first: {comments, next}; limit 1 to 100 (default 50), after a comment id", auth: false, query: { after: "string", limit: "integer" } },
  {
    method: "post",
    path: `${REPO}/issues/{number}/comments`,
    summary: "Comment on an issue or pull",
    auth: true,
    body: { body: "string" },
  },
  { method: "get", path: `${REPO}/runs`, summary: "List a repository's runs, newest first: { items, next_cursor }; kind deploy or agent, env an environment name, limit 1 to 200 (default 50), cursor a run id; a stranger's runs carry no cost, turns, agent session or node", auth: false, query: { kind: "string", env: "string", limit: "integer", cursor: "string" } },
  { method: "get", path: `${REPO}/runs/{id}`, summary: "Read one run as this reader may see it, with `carries`, the merged pulls a finished production deploy carries", auth: false },
  { method: "get", path: `${REPO}/runs/{id}/log`, summary: "Read a run's log as text/plain, one line per line; follow=1 or Accept: text/event-stream tails it live as server-sent events (line, then done); 404 when the log is hidden", auth: false, query: { follow: "string" } },
  {
    method: "post",
    path: `${REPO}/runs/{id}/cancel`,
    summary: "Cancel a run that has not finished (needs rw scope and write access); answers the cancelled run",
    auth: true,
    refusals: { finished: "the run has already finished (409)" },
  },
  {
    method: "get",
    path: `${REPO}/usage`,
    summary: "What the crew's runs here spent over a window, the owner's own facts: { app, days, since, total, bySubscription, byAgent, byIssue, recent, standing, spend, guard }; days 1 to 90; 403 to a reader who cannot write",
    auth: true,
    query: { days: "integer" },
    refusals: { invalid_days: "days is not a whole number from 1 to 90" },
  },
  {
    method: "post",
    path: `${REPO}/spend`,
    summary: "Report what an outside session spent on this repository's work (needs rw scope; writers and the crew); answers 201 with the record",
    auth: true,
    status: 201,
    body: { who: "string", tokensIn: "integer", tokensOut: "integer", usd: "number", model: "string", note: "string", issue: "integer" },
    refusals: { invalid: "who is 1 to 100 characters and some spend is given (tokensIn, tokensOut whole numbers; usd 0 to 10000); note is at most 500" },
  },
  { method: "get", path: `${REPO}/events`, summary: "Page through a repository's events as the caller may see them, newest first: {items, next_cursor}; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422", auth: false, query: { limit: "integer", cursor: "string" } },
  { method: "post", path: `${REPO}/forks`, summary: "Fork a repository", auth: true },
  {
    method: "post",
    path: `${REPO}/pulls`,
    summary: "Offer a change as a pull",
    auth: true,
    body: { title: "string", head: "string", headRepo: "string" },
  },
  { method: "get", path: `${REPO}/crew`, summary: "List the repository's crew; answers { items, next_cursor } (names and roles for every reader, brief, model and budget for writers)", auth: false },
  {
    method: "delete",
    path: `${REPO}/crew/{username}`,
    summary: "Take an agent off the repository's crew (admin scope, a repository admin's); answers {}",
    auth: true,
    refusals: { no_such_agent: "`username` names no one on the crew" },
  },
  { method: "get", path: `${REPO}/prompts`, summary: "List the repository's prompt sources (admin scope); answers { items, next_cursor }, tokens never come back", auth: true },
  {
    method: "post",
    path: `${REPO}/prompts`,
    summary: "Add a prompt source (admin scope); answers 201 with the source",
    auth: true,
    status: 201,
    body: { kind: "string", token: "string", at: "string" },
    refusals: { invalid: "`kind`, `token` or `at` is not acceptable (422)" },
  },
  { method: "delete", path: `${REPO}/prompts/{id}`, summary: "Remove a prompt source (admin scope); answers {}", auth: true },
  { method: "get", path: `${REPO}/egress-grants`, summary: "List the destinations the app may reach (admin scope); answers { items, changes, next_cursor }", auth: true },
  {
    method: "post",
    path: `${REPO}/egress-grants`,
    summary: "Grant the app one egress destination (admin scope); answers 201 with the grant",
    auth: true,
    status: 201,
    body: { destination: "string" },
    refusals: { invalid: "`destination` is not acceptable (422)" },
  },
  {
    method: "delete",
    path: `${REPO}/egress-grants`,
    summary: "Revoke one egress destination, named in the body (admin scope); answers {}",
    auth: true,
    body: { destination: "string" },
  },
  { method: "get", path: `${REPO}/hooks`, summary: "List the repository's webhooks (admin scope); answers an array of webhooks", auth: true },
  {
    method: "post",
    path: `${REPO}/hooks`,
    summary: "Add a webhook (admin scope); answers 201 with the webhook and its `secret`, shown once",
    auth: true,
    status: 201,
    body: { url: "string", kinds: "string", secret: "string" },
    refusals: { invalid: "`url` or `kinds` is not acceptable (422)" },
  },
  { method: "delete", path: `${REPO}/hooks/{id}`, summary: "Remove a webhook (admin scope); answers {}, 404 when it is not there", auth: true },
  {
    method: "get",
    path: `${REPO}/decisions`,
    summary: "Read the decision ledger; `kind` is next, land, retry or guard; answers { decisions, week }",
    auth: false,
    query: { kind: "string" },
  },
  { method: "get", path: `${REPO}/events`, summary: "Read the repository's event outbox, as this reader may see it; answers an array of events", auth: false },
  { method: "get", path: `${REPO}/flow`, summary: "Read the repository's flow over the last day", auth: false },
  {
    method: "post",
    path: `${REPO}/pulls/{number}/reviews`,
    summary: "Give a verdict on a pull",
    auth: true,
    body: { verdict: "string", body: "string" },
  },
  { method: "post", path: `${REPO}/pulls/{number}/merge`, summary: "Merge a pull (a person's)", auth: true },
  {
    method: "patch",
    path: REPO,
    summary:
      "Change a repository's settings (an admin's); `showProvenance` shows or hides where a migrated one came from (a person's, never an agent's)",
    auth: true,
    body: {
      description: "string",
      visibility: "string",
      archived: "boolean",
      showProvenance: "boolean",
    },
  },
  {
    method: "get",
    path: `${REPO}/following`,
    summary:
      "A fork's standing against its parent, read from git: { chain, severedAt, upstream, parent, parentBranch, parentFrozen, branch, state, behind, ahead, clean, conflicts, forkTip, parentTip, parentForge, converge }; a repository that only follows across forges answers { chain, severedAt, upstream }",
    auth: false,
    refusals: { not_a_fork: "404: this repository follows nothing" },
  },
  {
    method: "get",
    path: `${REPO}/following/proposals`,
    summary: "How each change proposed to the parent forge stands, as the parent last said; answers { items }",
    auth: false,
  },
  {
    method: "post",
    path: `${REPO}/following/converge`,
    summary: "Ask the crew to converge a diverged fork with its parent; answers { kind, issue, pull, agent } (202 when queued, 200 when working or proposed)",
    auth: true,
    refusals: {
      not_a_fork: "404: this repository follows nothing",
      forbidden: "403: only someone who may direct the crew",
      archived: "409: the repository is archived",
      ceiling: "429: the crew is at its ceiling",
    },
  },
  {
    method: "post",
    path: `${REPO}/following/propose`,
    summary: "Open a pull on the parent with what the fork is ahead by; answers { number, opened, changes, title }",
    auth: true,
    refusals: {
      not_a_fork: "404: this repository follows nothing",
      nothing_to_propose: "409: nothing here is ahead of the parent",
      refused: "409: the parent refused, with the reason",
    },
  },
  {
    method: "post",
    path: `${REPO}/following/propose-parent`,
    summary: "Across forges: push this forge's change to the parent forge and open the pull there; answers 201 when opened, 200 when one stands",
    auth: true,
    refusals: {
      no_parent_forge: "404: this repository has no parent forge to propose to",
      nothing_to_propose: "409: nothing here is ahead of the parent forge",
      parent_unreachable: "502: the parent forge did not answer",
      refused: "409: the parent forge refused, with the reason",
    },
  },
  {
    method: "post",
    path: `${REPO}/following/sever`,
    summary: "Stop following the parent forge; answers { severedAt }",
    auth: true,
    refusals: { not_following: "404: this repository follows nothing across forges" },
  },
  {
    method: "post",
    path: `${REPO}/following/take`,
    summary:
      "Take the parent's updates: a fork merges (the same answer as sync); the repository carrying this forge's code takes as a pull",
    auth: true,
    refusals: {
      not_a_fork: "404: this repository follows nothing",
      not_following: "404: this repository follows nothing across forges",
      conflict: "409: both sides changed these files; the crew was told; { files, converge, issue }",
      moved: "409: something moved while this was read; try again",
    },
  },
  {
    method: "patch",
    path: "/api/v1/forge/following",
    summary: "Choose how this forge follows the forge its code came from (its code repository's admin); answers { mode }",
    auth: true,
    body: { mode: "string" },
    refusals: {
      not_following: "404: this repository follows nothing across forges",
      forbidden: "403: only this forge's owner can change how it follows",
      invalid_mode: "422: mode is not one the forge knows",
      severed: "409: this forge is severed and follows nothing",
    },
  },
  {
    method: "get",
    path: `${REPO}/upstream`,
    summary: "The outside upstream this repository follows, for an admin: { following } (null when it follows none)",
    auth: true,
  },
  {
    method: "post",
    path: `${REPO}/upstream/check`,
    summary: "Check the followed upstream now (admin scope); answers the check's result",
    auth: true,
    refusals: { busy: "409: a check is already running", invalid_url: "422: not an https or http git address" },
  },
  {
    method: "post",
    path: `${REPO}/sync`,
    summary: "Sync a mirror with its origin, or let a fork take its parent's updates (a fork needs a writer)",
    auth: true,
    refusals: {
      not_a_fork: "404: this repository follows nothing",
      conflict: "409: both sides changed these files; the crew was told",
      moved: "409: something moved while this was read; try again",
    },
  },
  {
    method: "post",
    path: `${REPO}/make-it-yours`,
    summary:
      "Take an app as your own: a fork with its app; a dry run (the default, ro scope) answers the plan, dryRun false (rw scope) answers 201 with the plan and `url`",
    auth: true,
    body: { dryRun: "boolean", name: "string", visibility: "string" },
    refusals: {
      invalid: "422: visibility is public or private",
      own: "409: this app is already yours",
      unverified: "403: prove your email first",
      limit: "429: at most so many copies a day; { resetsAt }",
      repository_limit: "403: at the repository limit",
      storage_limit: "403: at the storage limit",
      not_member: "403: not a member",
    },
  },
  {
    method: "post",
    path: `${REPO}/origin/reconnect`,
    summary: "Reconnect a frozen mirror through one of your origins (admin scope, repository admin); answers the repository",
    auth: true,
    body: { originId: "string" },
  },
  { method: "get", path: `${REPO}/forks`, summary: "List the forks of a repository you can read", auth: false },
  { method: "get", path: `${REPO}/tags`, summary: "List a repository's tags: [{ name, oid, commit }]", auth: false },
  {
    method: "get",
    path: "/api/v1/family",
    summary: "The forge's family: { parent, here, children, more }; the parent for anyone, the children for a site admin",
    auth: false,
  },
  { method: "get", path: `${REPO}/app/production/open`, summary: "Open the running app", auth: false },
  { method: "get", path: `${REPO}/app`, summary: "Read the repository's app: its settings, environments and state", auth: false },
  {
    method: "post",
    path: `${REPO}/app`,
    summary: "Turn the repository into an app (admin scope); `access` is public or private, `previewData` is copy or empty; answers 201 with the app",
    auth: true,
    body: { slug: "string", access: "string", previewData: "string" },
    status: 201,
    refusals: { app_limit: "the owner is at the app limit" },
  },
  {
    method: "patch",
    path: `${REPO}/app`,
    summary: "Change the app's settings (admin scope); `access` is public or private, `previewData` is copy or empty",
    auth: true,
    body: { slug: "string", access: "string", previewData: "string" },
  },
  { method: "delete", path: `${REPO}/app`, summary: "Turn the app off (admin scope); answers {}", auth: true },
  { method: "get", path: `${REPO}/app/members`, summary: "Read the people a private app names; answers the members", auth: true },
  {
    method: "put",
    path: `${REPO}/app/members`,
    summary: "Set the people a private app names (admin scope, a person's, never an agent's); a plan unless dryRun is false",
    auth: true,
    body: { members: "array", dryRun: "boolean" },
    refusals: { invalid: "`members` is not a list of usernames" },
  },
  { method: "get", path: `${REPO}/app/domains`, summary: "List the app's own domains (admin scope); answers { items, next_cursor }", auth: true },
  {
    method: "post",
    path: `${REPO}/app/domains`,
    summary: "Add a domain of your own to the app (admin scope); answers 201 with the domain",
    auth: true,
    body: { host: "string" },
    status: 201,
  },
  { method: "delete", path: `${REPO}/app/domains/{host}`, summary: "Remove a domain from the app (admin scope); answers {}", auth: true },
  { method: "post", path: `${REPO}/app/domains/{host}/check`, summary: "Check that a domain points at the forge (admin scope); answers the domain", auth: true },
  { method: "get", path: `${REPO}/app/env`, summary: "List the names of the app's environment variables (admin scope); a value is written and never read back; answers { items, next_cursor }", auth: true },
  {
    method: "put",
    path: `${REPO}/app/env/{var}`,
    summary: "Set an environment variable (admin scope); the value is written and never read back; scope is all (default), production or preview",
    auth: true,
    body: { value: "string", scope: "string" },
  },
  {
    method: "delete",
    path: `${REPO}/app/env/{var}`,
    summary: "Unset an environment variable (admin scope); scope is all (default), production or preview; answers {}",
    auth: true,
    query: { scope: "string" },
  },
  {
    method: "post",
    path: `${REPO}/app/{env}/redeploy`,
    summary: "Redeploy an environment (rw scope); answers 202 with { run }",
    auth: true,
    status: 202,
  },
  { method: "post", path: `${REPO}/app/{env}/stop`, summary: "Stop an environment (rw scope); answers {}", auth: true },
  { method: "get", path: `${REPO}/map`, summary: "Read the plan: issues, their dependency edges and pillars", auth: false },
  {
    method: "post",
    path: `${REPO}/plan`,
    summary: "Open a plan of issues and their dependencies, all or nothing",
    auth: true,
    body: { issues: "array" },
  },
  {
    method: "post",
    path: "/api/v1/agents",
    summary: "Make an agent on the crew (an admin token, or a person's session); answers 201 with the agent",
    auth: true,
    status: 201,
    body: { username: "string", displayName: "string", model: "string", brief: "string", budgetUsd: "integer" },
    refusals: { forbidden: "a token below admin scope", unauthorized: "no account" },
  },
  { method: "get", path: "/api/v1/agents/{username}", summary: "Read one agent; the brief, model and budget show to those who may see them", auth: false, refusals: { not_found: "no such agent, or not yours to see" } },
  {
    method: "patch",
    path: "/api/v1/agents/{username}",
    summary: "Change an agent's model, brief or budget (an admin token, or a person's session); answers the agent",
    auth: true,
    body: { model: "string", brief: "string", budgetUsd: "integer" },
    refusals: { forbidden: "a token below admin scope" },
  },
  { method: "delete", path: "/api/v1/agents/{username}", summary: "Remove an agent (an admin token, or a person's session); answers {}", auth: true, refusals: { forbidden: "a token below admin scope", not_found: "no such agent" } },
  {
    method: "post",
    path: "/api/v1/orgs",
    summary: "Make an organisation (rw scope); answers 201 with { id, username, kind: \"org\" }",
    auth: true,
    status: 201,
    body: { name: "string" },
  },
  {
    method: "post",
    path: "/api/v1/orgs/{org}/teams",
    summary: "Make a team in an organisation (admin scope); answers 201 with the team",
    auth: true,
    status: 201,
    body: { name: "string", permission: "string" },
    refusals: { not_found: "no such organisation, or not yours to see" },
  },
  {
    method: "delete",
    path: "/api/v1/orgs/{org}/teams/{team}",
    summary: "Remove a team (admin scope); answers 204",
    auth: true,
    status: 204,
    refusals: { not_found: "no such team" },
  },
  {
    method: "post",
    path: "/api/v1/orgs/{org}/teams/{team}/members",
    summary: "Add a user to a team (admin scope); answers 201 with { added: true }, or 200 when they were already in",
    auth: true,
    status: 201,
    body: { user: "string" },
  },
  { method: "get", path: "/api/v1/contribute", summary: "How to contribute to a mirrored repository: the welcome for an arriving agent", auth: false },
  {
    method: "post",
    path: `${REPO}/contribute`,
    summary:
      "Send files to a mirror's upstream as a branch, and optionally a pull (rw scope); answers 201 with the contribution; a repository that is not a mirror answers not_found",
    auth: true,
    status: 201,
    body: { branch: "string", base: "string", message: "string", files: "array", openPull: "object" },
  },
  {
    method: "post",
    path: `${REPO}/edits`,
    summary:
      "Commit files without git (rw scope): files is [{ path, content }], content null deletes; answers 201 with { commit, branch, pull }",
    auth: true,
    status: 201,
    body: { branch: "string", base: "string", message: "string", newBranch: "string", files: "array", openPull: "object" },
    refusals: { no_files: "files holds nothing to write" },
  },
  {
    method: "post",
    path: "/api/v1/thoughts",
    summary: "Keep a thought (rw scope); answers 201 with { id }",
    auth: true,
    status: 201,
    body: { text: "string" },
    refusals: { invalid: "text is not a string within the length limit" },
  },
  {
    method: "get",
    path: "/api/v1/asked",
    summary: "What people asked, and the caller's thought stream; answers { asked, thoughts } (ro scope)",
    auth: true,
    query: { show: "string", order: "string", repo: "string" },
    refusals: { invalid_show: "show is all, unshipped or flagged", invalid_order: "order is oldest or newest" },
  },
  {
    method: "get",
    path: "/api/v1/returns",
    summary: "What the work returned over the last days, for the caller or one repository; never cached",
    auth: true,
    query: { repo: "string", days: "integer" },
    refusals: { invalid_days: "days is not a whole number in range" },
  },
  { method: "get", path: "/api/v1/here", summary: "The manifest of what you can do at `path`, given who you are; never cached", auth: false, query: { path: "string" } },
  { method: "get", path: "/api/v1/crew/scorecard", summary: "The crew's scorecard (ro scope, a forge admin's to read)", auth: true, refusals: { forbidden: "not a forge admin" } },
  {
    method: "post",
    path: `${REPO}/issues/{number}/dependencies`,
    summary: "Make an issue wait for another",
    auth: true,
    body: { blockedBy: "integer" },
  },
  {
    method: "delete",
    path: `${REPO}/issues/{number}/dependencies/{blocker}`,
    summary: "Stop an issue waiting for another",
    auth: true,
  },
  { method: "get", path: "/api/v1/forges", summary: "List the child forges (a site admin's, ro scope); answers { items, next_cursor: null }", auth: true },
  {
    method: "post",
    path: "/api/v1/forges",
    summary:
      "Make a forge, as a link: `dryRun` is true unless it is false and then answers 200 with { dryRun: true, plan, firstAdmin } and makes nothing; made, it answers 201 (200 when it already exists) with { dryRun: false, name, url, claimUrl, ... }. A signed-in caller needs rw scope; a stranger may call it, same-origin, rate-limited, with no crew, model key or `for`",
    auth: true,
    status: 201,
    body: {
      name: "string",
      apps: "array",
      crew: "array",
      dryRun: "boolean",
      direction: "string",
      keepAccess: "boolean",
      size: "string",
      for: "string",
      fresh: "boolean",
      followMode: "string",
      budgetUsd: "number",
      modelKey: "string",
      modelEndpoint: "string",
    },
    refusals: {
      invalid: "a field is missing or not valid",
      rate_limited: "a stranger has started enough forges today",
    },
  },
  { method: "get", path: "/api/v1/forges/sizes", summary: "What small, medium and large mean; public, cacheable by ETag", auth: false },
  {
    method: "post",
    path: "/api/v1/forges/{name}/claim-link",
    summary:
      "Make a new claim link for a forge nobody has claimed (a site admin's, rw scope); answers 201 with { name, claimUrl }. The link is shown once, here, and not again: the old link dies, so keep this one",
    auth: true,
    status: 201,
    refusals: { not_found: "no child forge has this name", forbidden: "the caller is not a site admin", claimed: "the forge is already claimed" },
  },
  { method: "get", path: "/api/v1/forge", summary: "A spawned forge's word about itself: claimed or not, to anyone; when anything last happened, only to its parent; not_found when it was not spawned", auth: false },
  {
    method: "get",
    path: "/api/v1/fleet/graph",
    summary: "Spend and runs per repository by UTC hour (24 h) and day (14 d); `repo` (owner/name) repeats, else every repository the caller may write that spent lately",
    auth: true,
    query: { repo: "string" },
    refusals: { invalid_selection: "`repo` is not a list of owner/name" },
  },
  {
    method: "get",
    path: "/api/v1/fleet/ops",
    summary: "List the fleet operations, newest first; answers { items, next_cursor }",
    auth: true,
    query: { limit: "integer", cursor: "string" },
  },
  { method: "get", path: "/api/v1/fleet/ops/{id}", summary: "Read one fleet operation and what it changed", auth: false },
  {
    method: "post",
    path: "/api/v1/fleet/ops",
    summary:
      "Plan or apply one action over the repositories a query selects; `dryRun` is true unless it is false: the plan needs ro scope and changes nothing (200, { dryRun: true, ... }), applying needs admin scope and answers 201 with { dryRun: false, ... }; each row is still checked against the actor's admin of its repository",
    auth: true,
    status: 201,
    body: { query: "string", action: "object", dryRun: "boolean" },
  },
  { method: "post", path: "/api/v1/fleet/ops/{id}/undo", summary: "Undo a fleet operation (admin scope); answers 201 with the undoing operation", auth: true, status: 201 },
  { method: "get", path: "/api/v1/front", summary: "The front page: what a stranger is shown; a site admin also gets the picks", auth: false },
  {
    method: "get",
    path: "/api/v1/health",
    summary: "How the forge is, uncached; anyone may ask, a stranger is told little, the release probe and a site admin the whole of it",
    auth: false,
  },
  { method: "get", path: "/api/v1/map", summary: "The global map: every repository the caller can see, with its issues and dependency edges", auth: false },
  {
    method: "post",
    path: "/api/v1/heartbeat",
    summary:
      "A child forge's signed heartbeat (counts and version, never data); only a child holding the parent's secret may call it, signed in the signature header, and body at most 1 KiB; answers { ok: true }, and every refusal is the same 404 `not_found`",
    auth: false,
    refusals: { not_found: "the beat is not signed by a child of this forge" },
  },
  {
    method: "post",
    path: "/api/v1/drills",
    summary:
      "Record a domain drill and its verdict, green or red (a site admin's, admin token only); answers 201 with the recorded drill",
    auth: true,
    status: 201,
    body: { domain: "string", seen: "object", backSeconds: "integer" },
    refusals: {
      unknown_domain: "`domain` is not one of the forge's failure domains",
      invalid_seen: "`seen` needs health and board as text",
      invalid_back: "`backSeconds` is not a whole number of seconds, 0 to 31536000",
      too_large: "the body is too large",
    },
  },
  {
    method: "post",
    path: "/api/v1/migrate",
    summary: "Migrate a repository here: source is { url } (needs rw scope) or { originId, fullName } (needs admin scope); after is leave, archive or mirror; answers 202 with the repo and its clone job",
    auth: true,
    body: { source: "object", owner: "string", name: "string", visibility: "string", branch: "string", after: "string", crew: "object" },
  },
  { method: "get", path: "/api/v1/migrate/{job}", summary: "Read a migration job's stage", auth: true },
  {
    method: "post",
    path: "/api/v1/users",
    summary:
      "Sign up: answers 201 with the new account { id, username, displayName, isAdmin, commitEmail }, never the admin; `email` is optional; `invite` is an invite link's token, `turnstile_token` the human check when the forge asks for one; refused from another origin with 403 forbidden",
    auth: false,
    status: 201,
    body: { username: "string", email: "string", password: "string", invite: "string", turnstile_token: "string" },
    refusals: {
      rate_limited: "429, too many sign-ups; retry-after says when",
      too_large: "413, the body is over the limit for a stranger's",
      signup_closed: "403, this forge makes no new accounts (or the invite is not one)",
      forbidden: "403, the name is not one this edge allows",
      passkey_required: "422, this forge signs up with a passkey on the web page",
      human_check: "422, the human check failed",
      invalid_username: "422, not a name an account may have",
      invalid_email: "422, not an email address",
      weak_password: "422, the password is too short",
      password_too_long: "422, the password is over the cap",
      username_taken: "422, another account has the name",
      username_reserved: "422, the name is reserved",
      email_taken: "422, another account has the address",
    },
  },
  {
    method: "post",
    path: "/api/v1/sessions",
    summary:
      "Sign in with a username and password: answers 201 with the account { id, username, displayName, isAdmin, commitEmail } and sets the HttpOnly forge_session cookie; refused from another origin with 403 forbidden",
    auth: false,
    status: 201,
    body: { username: "string", password: "string" },
    refusals: {
      unauthorized: "401, the username or password is wrong",
      too_many_attempts: "429, past the sign-in windows; retry-after says when",
      too_large: "413, the body is over the limit for a stranger's",
    },
  },
  {
    method: "delete",
    path: "/api/v1/sessions",
    summary: "Sign out the session in the forge_session cookie: answers 200 with {} and clears the cookie; refused from another origin with 403 forbidden",
    auth: false,
  },
  {
    method: "post",
    path: "/api/v1/first-admin",
    summary:
      "Make the forge's first admin with the operator's one-time code, no session or password: answers 201 with { user, scope, id, token, expiresAt, expiresIn }, the token shown once; scope is ro, rw or admin; expiresIn is whole seconds from 60 to a month (default a day); refused from another origin with 403 forbidden",
    auth: false,
    status: 201,
    body: { code: "string", username: "string", email: "string", scope: "string", name: "string", expiresIn: "integer" },
    refusals: {
      too_large: "413, the body is over the limit for a stranger's",
      invalid_scope: "422, scope is not ro, rw or admin",
      invalid_expiry: "422, expiresIn is not whole seconds in range",
      rate_limited: "429, too many attempts from here; retry-after says when",
      refused: "403, the code does not work or this forge already has an admin",
      invalid_username: "422, not a name an account may have",
      invalid_email: "422, not an email address",
      username_taken: "422, another account has the name",
      email_taken: "422, another account has the address",
      username_reserved: "422, the name is reserved",
      unfinished: "422, the account could not be finished; send again",
    },
  },
  {
    method: "post",
    path: "/api/v1/first-admin/recover",
    summary:
      "Get a stranded admin a new expiring token with the operator's recovery code; no account is made: answers 201 with { user, scope, id, token, expiresAt, expiresIn }; scope and expiresIn as for first-admin; refused from another origin with 403 forbidden",
    auth: false,
    status: 201,
    body: { code: "string", scope: "string", name: "string", expiresIn: "integer" },
    refusals: {
      too_large: "413, the body is over the limit for a stranger's",
      invalid_scope: "422, scope is not ro, rw or admin",
      invalid_expiry: "422, expiresIn is not whole seconds in range",
      rate_limited: "429, too many attempts from here; retry-after says when",
      refused: "403, the code does not work",
    },
  },
  {
    method: "post",
    path: "/mcp",
    summary: "The forge as an MCP server (JSON-RPC 2.0); see docs/MCP.md",
    auth: true,
    body: { jsonrpc: "string", id: "integer", method: "string", params: "object" },
  },
];

const schema = (t: string) => (t === "object" ? { type: "object" } : t === "array" ? { type: "array", items: { type: "object" } } : { type: t });

/** The document, for the forge served at `origin`. */
export function openapi(origin: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: m[1] === "number" || m[1] === "blocker" ? "integer" : "string" },
    }));
    const query = Object.entries(r.query ?? {}).map(([name, t]) => ({
      name,
      in: "query",
      required: false,
      schema:
        name === "state"
          ? { type: "string", enum: ["open", "closed", "all"] }
          : name === "fields"
            ? { type: "string", enum: ["brief"] }
            : name === "diff"
              ? { type: "string", enum: ["0", "1"], default: "1" }
              : schema(t),
    }));
    (paths[r.path] ??= {})[r.method] = {
      operationId: `${r.method}${r.path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase())}`,
      summary: r.summary,
      parameters: [...params, ...query],
      ...(r.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: Object.fromEntries(
                      Object.entries(r.body).map(([k, t]) => [k, schema(t)]),
                    ),
                  },
                },
              },
            },
          }),
      ...(r.auth ? { security: [{ token: [] }] } : {}),
      responses: {
        [String(r.status ?? 200)]: { description: "Done" },
        default: {
          description:
            "An error: { error, message }; `error` is a stable code" +
            (r.refusals === undefined
              ? ""
              : `. Refusals: ${Object.entries(r.refusals).map(([c, w]) => `\`${c}\` (${w})`).join("; ")}`),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "forge",
      version,
      description:
        "The routes the forge names to an agent. `not_found` means missing or not yours to see.",
    },
    servers: [{ url: origin }],
    paths,
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer" } },
    },
  };
}
