/**
 * The forge's admin surface over the API: every `/api/v1/admin…` route —
 * capacity, limits, crew teams, settings, invites, and accounts and people.
 * Hidden from everyone but a forge admin (the gate is `http/admin_gate.ts`).
 * Moved out of `api.ts` (#7445), unchanged.
 */


import { crawlReport } from "../../perf/crawlers.ts";
import { MAX_SECONDS, sampleStacks } from "../../perf/sample.ts";
import { listAccounts, removeAccount, retireAndRemoveAccount, retirementPlan, suspendAccount, unsuspendAccount, verifyAccount } from "../../actions/accounts.ts";
import { ADMIN_WORDS } from "../../actions/admin_words.ts";
import { changeCapacity, listCapacity } from "../../actions/capacity.ts";
import { inviteLink, list as listInviteLinks, mint as mintInviteLink, revoke as revokeInviteLink } from "../../actions/invites.ts";
import { changeLimit, listLimits } from "../../actions/limits.ts";
import { setAccountCeilings, setAccountGrant } from "../../actions/model_grant.ts";
import { checkPinned, deployPinned, pinnedForges, rollbackPinned, updatePinned } from "../../actions/pinned.ts";
import { TARGETS } from "../../cloud/targets.ts";
import { changeQuotas, readQuotas } from "../../actions/quotas.ts";
import { setRole } from "../../actions/roles.ts";
import { SETTING_WORDS } from "../../actions/setting_words.ts";
import { changeSignup, readSignup } from "../../actions/signup.ts";
import { SPEND_WORDS } from "../../actions/spend_words.ts";
import { TEAM_SAYS, changeTeam, readTeams } from "../../actions/teams.ts";
import { SIGNUP_WORDS } from "../../core/arg_words.ts";
import { lastOwnerSays, soleOwnedOrgs } from "../../core/orgs.ts";
import { listPeople } from "../../core/roles.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { getUserByName } from "../../core/users.ts";
import { holds, weakEtag } from "../etag.ts";
import { offsetPage, offsetQuery } from "../offset_page.ts";
import { body, json, str } from "../respond.ts";
import { offsetRefused } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { apiError, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

/** A forge admin's door: anyone else is told it is not there. */
export const accountAdmin = (ctx: Ctx, scope: "ro" | "admin"): Response | undefined =>
  ctx.auth.user?.isAdmin === true ? requireScope(ctx, scope) : notFound();

/**
 * Who can reach the forge, and its capacity, limits and quotas (#9248):
 * polled often and changed rarely (#9224). The tag
 * is of the exact bytes sent, so a person, invite or page change moves it and
 * two viewers shown different bodies never share one. Called only past the
 * access and query checks, which carry no tag.
 */
const taggedJson = (ctx: Ctx, data: unknown): Response => {
  const text = JSON.stringify(data);
  const etag = weakEtag(text);
  const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
  if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { "content-type": "application/json", ...headers } });
};

export function adminRoutes(router: Router<Handler>): void {
  // ---- pinned forges (#8697): one deploy, and a change only by Update ----
  const pinnedFail = (error: string): Response =>
    error === "not_found" || error === "No such pinned forge." ? notFound() : apiError("refused", 422, error);

  router.add("GET", "/api/v1/admin/pinned", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const seen = pinnedForges(ctx.app, ctx.auth.user);
    return seen.ok ? json({ items: seen.value, targets: TARGETS, next_cursor: null }) : notFound();
  });

  router.add("POST", "/api/v1/admin/pinned", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const i = await body(ctx.request);
    const made = await deployPinned(ctx.app, ctx.auth.user, {
      name: str(i.name), target: str(i.target), account: str(i.account), app: str(i.app),
      source: str(i.source), version: str(i.version), config: i.config,
    });
    return made.ok ? json(made.value, 201) : pinnedFail(made.error);
  });

  router.add("POST", "/api/v1/admin/pinned/:name/update", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const i = await body(ctx.request);
    const done = await updatePinned(ctx.app, ctx.auth.user, ctx.params.name!, {
      version: i.version === undefined ? undefined : str(i.version), config: i.config,
    });
    return done.ok ? json(done.value) : pinnedFail(done.error);
  });

  router.add("POST", "/api/v1/admin/pinned/:name/check", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = await checkPinned(ctx.app, ctx.auth.user, ctx.params.name!);
    return done.ok ? json(done.value) : pinnedFail(done.error);
  });

  router.add("POST", "/api/v1/admin/pinned/:name/rollback", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = await rollbackPinned(ctx.app, ctx.auth.user, ctx.params.name!);
    return done.ok ? json(done.value) : pinnedFail(done.error);
  });

  // ---- accounts: the owner's view of who joined (#660) ----
  const accountError = (error: string): Response =>
    error === "not_found"
      ? notFound()
      : error === "not_allowed"
        ? apiError(
            "not_allowed",
            422,
            ADMIN_WORDS.selfSuspend,
          )
        : apiError(error, 500, "the account could not be removed");

  // What the main thread is doing right now, sampled for a few seconds
  // (`perf/sample.ts`), so a stall can be read on the live forge (#8103).
  router.add("GET", "/api/v1/admin/profile", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    // Asked for by name: a sample holds the profiler on, so a bare GET never starts one.
    const asked = Number(ctx.url.searchParams.get("seconds") ?? Number.NaN);
    if (!Number.isFinite(asked)) return apiError("invalid", 422, `seconds is a number from 1 to ${MAX_SECONDS}`);
    const sampled = await sampleStacks(asked);
    return sampled ? json(sampled) : apiError("busy", 409, "a sample is already running");
  });

  // The crawlers' share of the last quarter hour's answering time, and who
  // was refused (#8129): the number the performance board reads.
  router.add("GET", "/api/v1/admin/crawlers", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    return json(crawlReport(ctx.app));
  });

  // The forge's capacity (`core/capacity.ts`): read and changed live by an
  // admin, never by an agent; anyone else is told the door is not there.
  router.add("GET", "/api/v1/admin/capacity", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const listed = timePhase(ctx.request, "capacity", () => listCapacity(ctx.app, ctx.auth.user));
    return timePhase(ctx.request, "render", () => (listed.ok ? taggedJson(ctx, { items: listed.value.settings, changes: listed.value.changes, next_cursor: null }) : notFound()));
  });

  router.add("PUT", "/api/v1/admin/capacity/:key", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const value = input.value === null ? null : str(input.value);
    const changed = changeCapacity(ctx.app, ctx.auth.user, ctx.params.key!, value);
    if (changed.ok) return json(changed.value);
    if (changed.error === "not_found") return notFound();
    return apiError(
      changed.error,
      422,
      changed.error === "no_such_setting"
        ? "no such capacity setting"
        : SETTING_WORDS.outOfRange,
    );
  });

  // The forge's limits (`settings/limits.ts`): the same door as capacity.
  router.add("GET", "/api/v1/admin/limits", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const listed = timePhase(ctx.request, "limits", () => listLimits(ctx.app, ctx.auth.user));
    return timePhase(ctx.request, "render", () => (listed.ok ? taggedJson(ctx, { items: listed.value.limits, changes: listed.value.changes, next_cursor: null }) : notFound()));
  });

  router.add("PUT", "/api/v1/admin/limits/:key", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const value =
      input.value === null
        ? null
        : typeof input.value === "number" && Number.isFinite(input.value)
          ? String(input.value)
          : str(input.value);
    const changed = changeLimit(ctx.app, ctx.auth.user, ctx.params.key!, value);
    if (changed.ok) return json(changed.value);
    if (changed.error.kind === "not_found") return notFound();
    return apiError(
      changed.error.kind,
      422,
      changed.error.kind === "no_such_limit"
        ? "no such limit"
        : changed.error.message,
    );
  });

  // Per-account quotas (`settings/quotas.ts`), key by key: the REST twin of MCP `quotas`.
  router.add("GET", "/api/v1/admin/quotas", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const read = readQuotas(ctx.app, ctx.auth.user);
    return read.ok ? taggedJson(ctx, { quotas: read.value.quotas, changes: read.value.changes }) : notFound();
  });

  router.add("PUT", "/api/v1/admin/quotas/:key", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const key = ctx.params.key!;
    // A body without `value` is a malformed request, not a request to clear: null clears.
    if (!("value" in input)) return apiError("invalid_quota", 422, 'send {"value": N}, or {"value": null} for no limit');
    const changed = changeQuotas(ctx.app, ctx.auth.user, { [key]: input.value });
    if (changed.ok) return json({ key, value: changed.value[key as keyof typeof changed.value], quotas: changed.value });
    if (changed.error === "not_found") return notFound();
    return apiError(changed.error, 422, changed.error === "no_such_quota" ? "no such quota" : "a quota is a positive whole number, or null for no limit");
  });

  // Crew teams (`core/teams.ts`): a forge admin who is a person; the page's door.
  router.add("GET", "/api/v1/admin/teams", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const read = timePhase(ctx.request, "teams", () => readTeams(ctx.app, ctx.auth.user));
    return read.ok ? timePhase(ctx.request, "render", () => json({ teams: read.value.teams })) : notFound();
  });

  router.add("PUT", "/api/v1/admin/teams/:slug", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const { charter, dial, members } = input;
    if (
      (charter !== undefined && typeof charter !== "string") ||
      (dial !== undefined && typeof dial !== "number" && typeof dial !== "string") ||
      (members !== undefined &&
        (!Array.isArray(members) || !members.every((m) => typeof m === "string")))
    )
      return apiError("invalid_body", 422, "send charter (text), dial (a whole number) and members (agent ids)");
    const changed = changeTeam(ctx.app, ctx.auth.user, ctx.params.slug ?? "", {
      ...(charter === undefined ? {} : { charter: charter as string }),
      ...(dial === undefined ? {} : { dial: String(dial) }),
      ...(members === undefined ? {} : { members: members as string[] }),
    });
    if (changed.ok) return json(changed.value);
    if (changed.error === "not_found") return notFound();
    return apiError(changed.error, 422, TEAM_SAYS[changed.error]);
  });

  // Per-account quotas (`core/quotas.ts`): null is no limit. Each is
  // asked when the thing is made or started (`settings/quotas.ts`), never of a
  // forge admin.
  router.add("GET", "/api/v1/admin/settings", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const { read, signup } = timePhase(ctx.request, "settings", () => ({
      read: readQuotas(ctx.app, ctx.auth.user),
      signup: readSignup(ctx.app, ctx.auth.user),
    }));
    return timePhase(ctx.request, "render", () =>
      read.ok && signup.ok ? json({ ...read.value, ...signup.value, signupChanges: signup.value.changes, changes: read.value.changes }) : notFound());
  });

  router.add("PATCH", "/api/v1/admin/settings", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if (input.signup !== undefined) {
      if (input.quotas !== undefined)
        return apiError("invalid_body", 422, "send signup or quotas, not both");
      const set = changeSignup(ctx.app, ctx.auth.user, input.signup);
      if (set.ok) return json({ signup: set.value });
      if (set.error === "not_found") return notFound();
      return apiError(set.error, 422, SIGNUP_WORDS);
    }
    const quotas = input.quotas;
    if (typeof quotas !== "object" || quotas === null || Array.isArray(quotas))
      return apiError("invalid_body", 422, "send {\"signup\": \"closed\"} or {\"quotas\": {\"repositories\": 5, \"apps\": null}}");
    const changed = changeQuotas(ctx.app, ctx.auth.user, quotas as Record<string, unknown>);
    if (changed.ok) return json({ quotas: changed.value });
    if (changed.error === "not_found") return notFound();
    return apiError(
      changed.error,
      422,
      changed.error === "no_such_quota"
        ? "no such quota"
        : "a quota is a positive whole number, or null for no limit",
    );
  });

  // Invite links (#2335): minted once, listed without tokens, revoked by id.
  router.add("POST", "/api/v1/admin/invites", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const made = mintInviteLink(ctx.app, ctx.auth.user, input.days);
    if (!made.ok)
      return made.error === "invalid_days"
        ? apiError("invalid", 422, SPEND_WORDS.inviteDays)
        : notFound();
    const origin = ctx.app.config.url ?? ctx.url.origin;
    return json(
      { ...made.value.invite, token: made.value.token, link: inviteLink(origin, made.value.token) },
      201,
    );
  });

  router.add("GET", "/api/v1/admin/invites", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const query = offsetQuery(ctx.url.searchParams);
    if ("error" in query) return offsetRefused(query.error);
    const listed = timePhase(ctx.request, "invites", () => listInviteLinks(ctx.app, ctx.auth.user));
    return listed.ok ? timePhase(ctx.request, "render", () => taggedJson(ctx, offsetPage(listed.value, query.limit, query.offset))) : notFound();
  });

  router.add("DELETE", "/api/v1/admin/invites/:id", (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = revokeInviteLink(ctx.app, ctx.auth.user, ctx.params.id!);
    return done.ok ? json(done.value) : notFound();
  });

  router.add("GET", "/api/v1/admin/accounts", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const query = offsetQuery(ctx.url.searchParams);
    if ("error" in query) return offsetRefused(query.error);
    const listed = timePhase(ctx.request, "accounts", () => listAccounts(ctx.app, ctx.auth.user));
    return listed.ok ? timePhase(ctx.request, "render", () => taggedJson(ctx, offsetPage(listed.value, query.limit, query.offset))) : notFound();
  });

  router.add("POST", "/api/v1/admin/accounts/:username/suspend", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const done = await suspendAccount(ctx.app, ctx.auth.user, ctx.params.username!, {
      confirmed: input.confirm === true,
    });
    if (!done.ok && done.error === "last_owner")
      return apiError(
        "last_owner",
        409,
        `${lastOwnerSays(ctx.app.db, ctx.params.username!)}, or send {"confirm": true} to suspend anyway`,
      );
    return done.ok ? json({ username: done.value.username, suspendedAt: done.value.suspendedAt }) : accountError(done.error);
  });

  // A capped model grant, dollars a month; null (or 0) takes it back.
  router.add("POST", "/api/v1/admin/accounts/:username/model-grant", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const raw = input.usdPerMonth;
    if (raw !== null && (typeof raw !== "number" || !Number.isFinite(raw)))
      return apiError("invalid", 422, "usdPerMonth is a number of dollars, or null to take the grant back");
    const done = setAccountGrant(ctx.app, ctx.auth.user, ctx.params.username!, raw === 0 ? null : raw);
    if (done.ok) return json(done.value);
    return done.error === "invalid_amount"
      ? apiError("invalid", 422, SPEND_WORDS.usdPerMonth)
      : done.error === "not_allowed"
        ? apiError("not_allowed", 422, "a grant is for a person who is not an admin")
        : notFound();
  });

  // Every person and their role.
  router.add("GET", "/api/v1/admin/people", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const query = offsetQuery(ctx.url.searchParams);
    if ("error" in query) return offsetRefused(query.error);
    const people = timePhase(ctx.request, "people", () => listPeople(ctx.app.db));
    return timePhase(ctx.request, "render", () => taggedJson(ctx, offsetPage(people, query.limit, query.offset)));
  });

  // Make a person a member (with an optional starter allowance, dollars a month) or a guest again.
  router.add("POST", "/api/v1/admin/accounts/:username/role", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const { role, usdPerMonth } = input;
    if ((role !== "member" && role !== "guest") || (usdPerMonth !== undefined && usdPerMonth !== null && (typeof usdPerMonth !== "number" || !Number.isFinite(usdPerMonth))))
      return apiError("invalid", 422, 'role is "member" or "guest"; usdPerMonth is dollars a month, or null');
    const done = setRole(ctx.app, ctx.auth.user, ctx.params.username!, role, typeof usdPerMonth === "number" ? usdPerMonth : null);
    if (done.ok) return json(done.value);
    return done.error === "invalid_amount"
      ? apiError("invalid", 422, SPEND_WORDS.usdPerMonth)
      : done.error === "not_allowed"
        ? apiError("not_allowed", 422, "a role is for a person who is not an admin")
        : notFound();
  });

  // An account's daily and per-run model spend ceilings, dollars (any account, orgs too).
  router.add("POST", "/api/v1/admin/accounts/:username/ceiling", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const { dailyUsd, perRunUsd } = input;
    const amount = (v: unknown): v is number | null =>
      v === null || (typeof v === "number" && Number.isFinite(v));
    if (!amount(dailyUsd) || !amount(perRunUsd))
      return apiError("invalid", 422, "dailyUsd and perRunUsd are numbers of dollars, both null to take them back");
    const done = setAccountCeilings(ctx.app, ctx.auth.user, ctx.params.username!, dailyUsd, perRunUsd);
    if (done.ok) return json(done.value);
    return done.error === "invalid_amount"
      ? apiError("invalid", 422, SPEND_WORDS.ceilings)
      : notFound();
  });

  router.add("POST", "/api/v1/admin/accounts/:username/unsuspend", (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = unsuspendAccount(ctx.app, ctx.auth.user, ctx.params.username!);
    return done.ok ? json({ username: done.value.username, suspendedAt: null }) : accountError(done.error);
  });

  router.add("POST", "/api/v1/admin/accounts/:username/verify", (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = verifyAccount(ctx.app, ctx.auth.user, ctx.params.username!);
    return done.ok
      ? json({ username: done.value.username, verified: true })
      : accountError(done.error);
  });

  router.add("DELETE", "/api/v1/admin/accounts/:username", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if (input.retireOrgs === true) {
      const name = ctx.params.username!;
      if (input.confirm !== true) {
        const plan = retirementPlan(ctx.app, ctx.auth.user, name);
        return plan.ok ? json({ confirm_required: true, retire: plan.value.orgs, own: plan.value.own }) : accountError(plan.error);
      }
      const retired = await retireAndRemoveAccount(ctx.app, ctx.auth.user, name, {
        confirmed: true,
      });
      if (!retired.ok) return accountError(retired.error);
      if (retired.value.failed !== null)
        return json(
          { error: "delete_failed", failed: retired.value.failed, removed: retired.value.removed },
          500,
        );
      return json({ removed: name, retired: retired.value.removed });
    }
    const done = await removeAccount(ctx.app, ctx.auth.user, ctx.params.username!);
    if (!done.ok && done.error === "last_owner") {
      const user = getUserByName(ctx.app.db, ctx.params.username!);
      const orgs =
        user === undefined
          ? []
          : soleOwnedOrgs(ctx.app.db, user.id).map((o) => o.username);
      return apiError(
        "last_owner",
        409,
        `${ctx.params.username} is the only person owning ${orgs.join(", ")}: make someone else an owner first`,
      );
    }
    return done.ok ? json({ removed: ctx.params.username }) : accountError(done.error);
  });
}
