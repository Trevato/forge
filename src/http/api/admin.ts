/**
 * The forge's admin surface over the API: every `/api/v1/admin…` route —
 * capacity, limits, crew teams, settings, invites, and accounts and people.
 * Hidden from everyone but a forge admin (the gate is `http/admin_gate.ts`).
 * Moved out of `api.ts` (#7445), unchanged.
 */


import { crawlReport } from "../../perf/crawlers.ts";
import { getAppById } from "../../core/apps.ts";
import { FUNNEL_SCOPE, daysOf, funnelReport } from "../../perf/funnel.ts";
import { probeViews } from "../../perf/views_probe.ts";
import { daysOf as visitorDaysOf, probeVisitors, visitorsReport } from "../../perf/visitor_report.ts";
import { getReturning } from "../../settings/returning.ts";
import { kpiProbe } from "../../web/studio/kpi_probe.ts";
import { MAX_SECONDS, sampleStacks } from "../../perf/sample.ts";
import { listAccounts, removeAccount, retireAndRemoveAccount, retirementPlan, suspendAccount, unsuspendAccount, verifyAccount } from "../../actions/accounts.ts";
import { ACCESS_WORDS, accessUrl, endAllSessions, resetAccess } from "../../actions/account_access.ts";
import { ADMIN_WORDS } from "../../actions/admin_words.ts";
import { DERIVED_WORDS, REASON_WORDS, changeCapacity, edgeOffDryRun, listCapacity } from "../../actions/capacity.ts";
import { changeShield, lastShieldChange, shieldState } from "../../actions/shield.ts";
import { inviteLink, list as listInviteLinks, mint as mintInviteLink, revoke as revokeInviteLink } from "../../actions/invites.ts";
import { changeLimit, listLimits } from "../../actions/limits.ts";
import { changePlans } from "../../actions/plans.ts";
import { setAccountCeilings, setAccountGrant } from "../../actions/model_grant.ts";
import { checkPinned, deployPinned, pinnedForges, rollbackPinned, updatePinned } from "../../actions/pinned.ts";
import { TARGETS } from "../../cloud/targets.ts";
import { changeQuotas, readQuotas } from "../../actions/quotas.ts";
import { allowRequest, declineRequest, listRequests } from "../../actions/requests.ts";
import { setRole } from "../../actions/roles.ts";
import { SETTING_WORDS } from "../../actions/setting_words.ts";
import { BILLING_WORDS } from "../../settings/billing.ts";
import { changeBillingLinks, changeForgeSource, changeSignup, readBillingLinks, readForgeSource, readSignup } from "../../actions/signup.ts";
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

  // Every home number: what the tile shows, what it counts, and its raw inputs
  // read again without the home cache, so anyone can compare.
  router.add("GET", "/api/v1/admin/kpis/probe", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    return json(kpiProbe(ctx.app));
  });

  // The selling funnel for the last `days` (`perf/funnel.ts`): the same figures as Settings → Billing.
  router.add("GET", "/api/v1/admin/billing/funnel", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    return json(funnelReport(ctx.app.db, daysOf(ctx.url.searchParams.get("days"))), 200, { "cache-control": "private, no-cache" });
  });

  // The traffic view's numbers, each counted again another way (`perf/views_probe.ts`).
  // `scope` is `forge` or an app's id; `number`, `dimension`+`key` and `steps` pick what to show.
  router.add("GET", "/api/v1/admin/traffic/probe", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const q = ctx.url.searchParams;
    const scope = q.get("scope") ?? "forge";
    if (scope !== "forge" && scope !== FUNNEL_SCOPE && getAppById(ctx.app.db, scope) === undefined) return notFound();
    const probed = probeViews(ctx.app.db, scope, q.get("window"), q.get("who") === "scrapers" ? "scrapers" : "people", Date.now(), {
      dimension: q.get("dimension"),
      key: q.get("key"),
      steps: q.get("steps"),
    });
    const only = q.get("number");
    return json(only === null ? probed : { ...probed, numbers: probed.numbers.filter((n) => n.id === only) });
  });

  // Who comes back (`perf/visitor_report.ts`, #11265): the same figures as the Traffic page.
  router.add("GET", "/api/v1/admin/traffic/visitors", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const now = Date.now();
    const days = visitorDaysOf(ctx.url.searchParams.get("days"));
    const r = visitorsReport(ctx.app.db, days, now);
    return json({
      as_of: new Date(now).toISOString(),
      enabled: getReturning(ctx.app.db),
      days: r.days,
      per_day: r.perDay.map((d) => ({
        day: d.day,
        new_cookie: d.newCookie,
        returning_cookie: d.returningCookie,
        new_probable: d.newProbable,
        returning_probable: d.returningProbable,
      })),
      new_visitors: r.newVisitors,
      returning_visitors: r.returningVisitors,
      returning: r.returning.map((v) => ({
        id: v.id,
        probable: v.probable,
        visits: v.visits,
        days_seen: v.daysSeen,
        first_seen: v.firstSeen,
        last_seen: v.lastSeen,
        first_ref: v.firstRef,
        last_ref: v.lastRef,
        step: v.step,
        forge: v.forge,
      })),
      led: r.led.map((l) => ({ forge: l.forge, id: l.id, probable: l.probable, step: l.step, first_ref: l.firstRef, visits: l.visits })),
      probe: probeVisitors(ctx.app.db, days, now, r),
    });
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
    // A dry run changes nothing, whatever the key: only signin.edge has one.
    if (input.dry_run !== undefined && input.dry_run !== false) {
      if (input.dry_run !== true || ctx.params.key !== "signin.edge") return notFound();
      const dry = edgeOffDryRun(ctx.app.db, ctx.auth.user);
      return dry.ok ? json({ dry_run: true, ...dry.value }) : notFound();
    }
    const value = input.value === null ? null : str(input.value);
    const reason = typeof input.reason === "string" ? input.reason : "";
    const changed = changeCapacity(ctx.app, ctx.auth.user, ctx.params.key!, value, reason);
    if (changed.ok) return json(changed.value);
    if (changed.error === "not_found") return notFound();
    return apiError(
      changed.error,
      422,
      changed.error === "no_such_setting"
        ? "no such capacity setting"
        : changed.error === "derived"
          ? DERIVED_WORDS
          : changed.error === "reason_required"
            ? REASON_WORDS
            : SETTING_WORDS.outOfRange,
    );
  });

  // The Shield (`actions/shield.ts`): usable with curl alone (`docs/SECURITY-RUNBOOK.md`).
  router.add("GET", "/api/v1/admin/shield", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    return json({ state: shieldState(ctx.app), last_change: lastShieldChange(ctx.app.db) });
  });

  router.add("PUT", "/api/v1/admin/shield", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const changed = changeShield(ctx.app, ctx.auth.user, input.state);
    if (changed.ok) return json(changed.value);
    if (changed.error === "not_found") return notFound();
    return apiError(changed.error, 422, "state must be open, ceiling or signin");
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

  // The plans (`settings/plans.ts`): the whole list is replaced; GET is the public /api/v1/plans.
  router.add("PUT", "/api/v1/admin/plans", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const changed = changePlans(ctx.app, ctx.auth.user, input["plans"]);
    if (changed.ok) return json({ items: changed.value });
    if (changed.error === "not_found") return notFound();
    return apiError("invalid_plans", 422, changed.error.invalid);
  });

  // The payment links (`settings/billing.ts`): the whole object is replaced; the REST twin of MCP `signup` with billingLinks.
  router.add("PUT", "/api/v1/admin/billing/links", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const set = changeBillingLinks(ctx.app, ctx.auth.user, input["links"]);
    if (set.ok) return json({ links: set.value });
    if (set.error === "not_found") return notFound();
    return apiError(set.error, 422, BILLING_WORDS);
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
    const { read, signup, source, billing } = timePhase(ctx.request, "settings", () => ({
      billing: readBillingLinks(ctx.app, ctx.auth.user),
      read: readQuotas(ctx.app, ctx.auth.user),
      signup: readSignup(ctx.app, ctx.auth.user),
      source: readForgeSource(ctx.app, ctx.auth.user),
    }));
    return timePhase(ctx.request, "render", () =>
      read.ok && signup.ok && source.ok && billing.ok
        ? json({ billingLinks: billing.value, ...read.value, ...signup.value, ...source.value, signupChanges: signup.value.changes, changes: read.value.changes })
        : notFound());
  });

  router.add("PATCH", "/api/v1/admin/settings", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const sent = [input.signup, input.quotas, input.forgeRepo, input.billingLinks].filter((v) => v !== undefined).length;
    if (sent > 1) return apiError("invalid_body", 422, "send one of signup, quotas, forgeRepo or billingLinks");
    if (input.billingLinks !== undefined) {
      const set = changeBillingLinks(ctx.app, ctx.auth.user, input.billingLinks);
      if (set.ok) return json({ billingLinks: set.value });
      if (set.error === "not_found") return notFound();
      return apiError(set.error, 422, BILLING_WORDS);
    }
    if (input.forgeRepo !== undefined) {
      const set = changeForgeSource(ctx.app, ctx.auth.user, input.forgeRepo);
      if (set.ok) return json({ forgeRepo: set.value });
      if (set.error === "not_found") return notFound();
      return apiError(set.error, 422, "forgeRepo is owner/name, or null to clear");
    }
    if (input.signup !== undefined) {
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

  // Strangers waiting for an account (#10928), and the answer to each.
  router.add("GET", "/api/v1/admin/requests", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const listed = listRequests(ctx.app, ctx.auth.user);
    return listed.ok ? json({ items: listed.value, next_cursor: null }) : notFound();
  });
  const answerRequest = (act: "allow" | "decline"): Handler => (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = (act === "allow" ? allowRequest : declineRequest)(ctx.app, ctx.auth.user, ctx.params.username!);
    if (done.ok) return json(done.value);
    return done.error === "not_waiting" ? apiError("not_waiting", 409, "that request is not waiting") : notFound();
  };
  router.add("POST", "/api/v1/admin/requests/:username/allow", answerRequest("allow"));
  router.add("POST", "/api/v1/admin/requests/:username/decline", answerRequest("decline"));

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

  // A one-time link, good for an hour, for a person to set a new password and add a passkey;
  // `endSessions` also signs them out. The admin never sees the password (#11688).
  router.add("POST", "/api/v1/admin/accounts/:username/reset", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if ((input.endSessions !== undefined && typeof input.endSessions !== "boolean") || (input.dryRun !== undefined && typeof input.dryRun !== "boolean"))
      return apiError("invalid", 422, "endSessions and dryRun are true or false");
    const done = await resetAccess(ctx.app, ctx.auth.user, ctx.params.username!, {
      endAll: input.endSessions === true,
      dryRun: input.dryRun === true,
    });
    if (!done.ok) return done.error === "not_found" ? notFound() : apiError("not_allowed", 422, ACCESS_WORDS.notAllowed);
    const { token, ...rest } = done.value;
    return json(token === undefined ? rest : { ...rest, url: accessUrl(ctx.app, token) });
  });

  // End every browser a person is signed in on.
  router.add("POST", "/api/v1/admin/accounts/:username/end-sessions", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
      return apiError("invalid", 422, "dryRun is true or false");
    const done = endAllSessions(ctx.app, ctx.auth.user, ctx.params.username!, { dryRun: input.dryRun === true });
    if (!done.ok) return done.error === "not_found" ? notFound() : apiError("not_allowed", 422, ACCESS_WORDS.notAllowed);
    return json(done.value);
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
