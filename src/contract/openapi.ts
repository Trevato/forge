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
  { method: "get", path: `${REPO}/events`, summary: "Page through a repository's events as the caller may see them, newest first: {items, next_cursor}; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422", auth: false, query: { limit: "integer", cursor: "string" } },
  { method: "post", path: `${REPO}/forks`, summary: "Fork a repository", auth: true },
  {
    method: "post",
    path: `${REPO}/pulls`,
    summary: "Offer a change as a pull",
    auth: true,
    body: { title: "string", head: "string", headRepo: "string" },
  },
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
