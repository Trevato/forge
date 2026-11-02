/**
 * Subscriptions — the Claude accounts the crew works on, and where each is
 * used. The pool is a forge admin's: an account is money, so only an admin
 * adds one, removes one, or says which repository or organization it pays
 * for. A token is typed once and never shown again.
 */

import { listAgents, type Agent } from "../../core/agents.ts";
import {
  addSubscription,
  API_BASE_MAX,
  budgetsOf,
  deleteSubscription,
  EVERYONE,
  listGrantPlaces,
  listGrants,
  listCredentials,
  listSubscriptions,
  NAME_MAX,
  PLATFORM,
  scopesOf,
  setBudget,
  setGrants,
  wakeSubscription,
  type Subscription,
} from "../../core/subscriptions.ts";
import {
  addRefusal,
  SUBSCRIPTION_WORDS,
} from "../../core/subscriptions_words.ts";
import {
  HEADROOM_MAX,
  headroomPct,
  setHeadroom,
  standings,
  type WindowStanding,
} from "../../core/standing.ts";
import { getUserById } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo, page } from "../layout.ts";
import {
  badge,
  btn,
  card,
  confirmAction,
  empty,
  listCard,
  row,
  time,
  timeAgo,
  tokenCount,
  userLink,
} from "../ui.ts";
import { windowParts } from "../../actions/standing_words.ts";
import { whenText } from "../../crew/limits.ts";
import { accountSections } from "./origins.ts";
import { liveRegionsJs } from "../client.ts";
import { markOf } from "../../core/marks.ts";
import { limitValue } from "../../settings/limits.ts";

const POOL = "/settings/subscriptions";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

const kindText = (s: Subscription): string =>
  s.id === PLATFORM
    ? "The forge's own token, from its environment"
    : s.kind === "oauth"
      ? "Claude subscription"
      : s.apiBase !== null
        ? `API key via ${s.apiBase}`
        : "API key";

/** One window's sentence (`actions/standing_words.ts`), as the terminal says it too. */
function windowText(w: WindowStanding): Html {
  const { head, tokens, tail } = windowParts(w);
  return html`${head}${when(tokens > 0, () => html` · ${tokenCount(tokens, "counted")}`)}${tail}`;
}

const resting = (s: Subscription, now: Date): boolean =>
  s.restingUntil !== null && s.restingUntil > now.toISOString();

function shell(ctx: Ctx, body: Html): Response {
  return page({
    ctx,
    title: "Subscriptions",
    body: html`<div class="page-head"><h1>Subscriptions</h1></div>
      ${settingsLayout(
        accountSections("subscriptions", { admin: true }),
        body,
        "Account settings",
      )}`,
    scriptJs: liveRegionsJs,
  });
}

// GET /settings/subscriptions
export function subscriptionsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const now = new Date();
  const pool = timePhase(ctx.request, "credentials", () =>
    listCredentials(ctx.app.db),
  );
  const places = timePhase(ctx.request, "places", () =>
    listGrantPlaces(ctx.app.db),
  );
  const scopes = timePhase(ctx.request, "scopes", () => scopesOf(ctx.app.db));
  const scopeText = (s: Subscription): string =>
    s.id === PLATFORM
      ? "the crew's: every app no subscription is granted to"
      : scopes.has(s.id)
        ? `for ${scopes.get(s.id)!.join(", ")}`
        : "not offered to the crew — granted nowhere";
  const budgets = timePhase(ctx.request, "budgets", () =>
    budgetsOf(ctx.app.db),
  );
  const standingOf = timePhase(ctx.request, "standings", () =>
    standings(
      ctx.app.db,
      pool.map((s) => s.id),
      now,
    ),
  );
  const rendering = performance.now();

  const sealed = pool.filter((s) => s.id !== PLATFORM);
  const none =
    sealed.length > 0
      ? null
      : empty({
          icon: "key",
          title: "The crew works on the forge's own token",
          note: "Add a subscription here and grant it to a repository or an organization; its runs spend that account instead. One granted nowhere is never offered to the crew.",
        });
  const list =
    pool.length === 0
      ? empty({
          icon: "key",
          title: "The crew works on the forge's own token",
          note: "Add a subscription here and grant it to a repository or an organization; its runs spend that account instead. Two on one grant take turns, and one the provider rests hands over to the other.",
        })
      : listCard(
          pool.map((s) => {
            const rests = resting(s, now);
            const st = standingOf.get(s.id);
            const budget = budgets.get(s.id);
            const by =
              s.createdBy === null
                ? undefined
                : getUserById(ctx.app.db, s.createdBy);
            return row({
              lead: icon("key"),
              title: html`${s.name}
              ${when(rests, () =>
                badge(`resting until ${whenText(new Date(s.restingUntil!))}`, {
                  tone: "attn",
                  icon: "clock",
                }),
              )}`,
              meta: html`${kindText(s)} · ${scopeText(s)}${s.id === PLATFORM
                ? null
                : html` · added ${time(s.createdAt)}`}${by
                ? html` by ${userLink(by.username, { mark: markOf(by) })}`
                : null}
              ·
              ${s.lastUsedAt === null
                ? "never used"
                : html`last used ${timeAgo(s.lastUsedAt)}`}${when(
                rests && s.restingSaid !== "",
                () => html` · ${s.restingSaid}`,
              )}${when(
                budget?.budgetUsd != null,
                () =>
                  html`<br /><span class="budget-line"
                      >spent ${dollars(budget!.spentUsd)} of a
                      ${dollars(budget!.budgetUsd!)} budget${budget!.locked
                        ? " set by whoever made this forge; add your own key to spend more"
                        : ""}</span
                    >`,
              )}${when(
                st !== undefined,
                () =>
                  html`<br />${st!.windows.map((w, i) =>
                    i === 0 ? windowText(w) : html` · ${windowText(w)}`,
                  )}`,
              )}`,
              trail: html`${when(
                st !== undefined,
                () =>
                  html`<form
                    class="row-fields"
                    method="post"
                    action="${POOL}/${s.id}/headroom"
                  >
                    <label for="h-${s.id}" class="small muted"
                      >kept for people, %</label
                    >
                    <input
                      class="input"
                      id="h-${s.id}"
                      name="headroom"
                      type="number"
                      min="0"
                      max="${HEADROOM_MAX}"
                      step="1"
                      value="${st!.headroomPct}"
                    />
                    ${btn("Keep", { size: "sm" })}
                  </form>`,
              )}
              ${when(
                s.id !== PLATFORM,
                () =>
                  html`<form
                    class="row-fields"
                    method="post"
                    action="${POOL}/${s.id}/budget"
                  >
                    <label for="b-${s.id}" class="small muted"
                      >budget, $</label
                    >
                    <input
                      class="input"
                      id="b-${s.id}"
                      name="budget"
                      type="number"
                      min="1"
                      max="${budget?.locked ? budget.budgetUsd : limitValue(ctx.app.db, "subscription.budget_max_usd")}"
                      step="1"
                      placeholder="none"
                      value="${budget?.budgetUsd ?? ""}"
                    />
                    ${btn("Set", { size: "sm" })}
                  </form>`,
              )}
              ${when(
                rests,
                () =>
                  html`<form
                    class="row-actions"
                    method="post"
                    action="${POOL}/${s.id}/wake"
                  >
                    ${btn("Use again now", { size: "sm", icon: "play" })}
                  </form>`,
              )}
              ${when(s.id !== PLATFORM, () =>
                confirmAction({
                  action: `${POOL}/${s.id}/delete`,
                  verb: "Remove",
                  size: "sm",
                }),
              )}`,
            });
          }),
          { extra: "setting-list" },
        );

  const add = card(
    html`<form class="stack" method="post" action="${POOL}">
      <div class="field">
        <label for="f-name">Name</label>
        <input
          class="input"
          id="f-name"
          name="name"
          maxlength="${NAME_MAX}"
          placeholder="work"
          required
          autocomplete="off"
        />
      </div>
      <div class="field">
        <label for="f-token">Token</label>
        <input
          class="input"
          id="f-token"
          name="token"
          type="password"
          placeholder="sk-ant-… or any provider's key"
          required
          autocomplete="off"
          spellcheck="false"
        />
        <span class="hint"
          ><code>claude setup-token</code> prints a subscription's token; an
          Anthropic API key or an OpenRouter key (<code>sk-or-v1-…</code>)
          works too. It is sealed on this forge and never shown again.</span
        >
      </div>
      <div class="field">
        <label for="f-api-base">API base URL (optional)</label>
        <input
          class="input"
          id="f-api-base"
          name="apiBase"
          type="url"
          maxlength="${API_BASE_MAX}"
          placeholder="https://openrouter.ai/api"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="hint"
          >Anthropic-compatible gateway for Claude Code. OpenRouter:
          <code>https://openrouter.ai/api</code> (no <code>/v1</code> — the
          SDK adds it). Leave empty for Anthropic itself; a setup-token
          (sk-ant-oat…) takes none.</span
        >
      </div>
      <div>${btn("Add", { variant: "primary", size: "sm", icon: "plus" })}</div>
    </form>`,
    {
      head: html`${icon("plus")}
        <h2>Add one</h2>`,
    },
  );

  const used =
    places.length === 0
      ? null
      : card(
          html`<ul class="list">
            ${places.map(
              (g) =>
                html`<li>
                  <div class="row">
                    <span class="row-lead">${icon("key")}</span>
                    <span class="row-main">
                      <span class="row-title">${g.subscription}</span>
                      <span class="row-meta"
                        >${g.place} ·
                        ${g.agent === undefined
                          ? "everyone on the crew"
                          : g.agent}</span
                      >
                    </span>
                    <a class="row-trail small" href="${g.href}">change</a>
                  </div>
                </li>`,
            )}
          </ul>`,
          {
            pad: false,
            head: html`${icon("map")}
              <h2>Where each is used</h2>`,
          },
        );

  const response = shell(
    ctx,
    html`${list} ${none === null ? null : html`<div class="mt">${none}</div>`}
      ${when(
        pool.length > 0,
        () =>
          html`<p class="muted small mt">
            Windows in US dollars of list price. A figure marked ~ is inferred
            from what the crew's runs spent; the rest the provider said. The
            cap is learned the first time the provider calls a window full,
            and the share kept for people is never spent by the crew. Tokens
            are what the crew's runs read and wrote in the window, counted by
            Claude's tokenizer.
          </p>`,
      )}
      <p class="mt muted small">What these accounts spent, by credential, app, agent, issue and run kind: <a href="/settings/spend">Usage → Spend</a>.</p>
      <div class="mt">${add}</div>
      ${used === null ? null : html`<div class="mt">${used}</div>`}`,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/subscriptions
export async function subscriptionAdd(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const name = field(form, "name");
  const added = addSubscription(ctx.app.db, ctx.app.config.dataDir, {
    name,
    token: field(form, "token").trim(),
    apiBase: field(form, "apiBase").trim(),
    createdBy: ctx.auth.user!.id,
  });
  if (!added.ok) {
    return flashTo(ctx, POOL, {
      tone: "danger",
      message: addRefusal(added.error, name),
    });
  }
  return flashTo(ctx, POOL, {
    message: `${added.value.name} is in the pool. Grant it to a repository under its Settings → Crew, or to an organization on its page.`,
  });
}

// POST /settings/subscriptions/:id/delete
export async function subscriptionDelete(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const removed = deleteSubscription(ctx.app.db, ctx.params.id ?? "");
  return flashTo(
    ctx,
    POOL,
    removed
      ? {
          message: SUBSCRIPTION_WORDS.removed,
        }
      : { tone: "danger", message: SUBSCRIPTION_WORDS.not_found },
  );
}

// POST /settings/subscriptions/:id/wake
export async function subscriptionWake(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  wakeSubscription(ctx.app.db, ctx.params.id ?? "");
  return flashTo(ctx, POOL, { message: "In use again." });
}

// POST /settings/subscriptions/:id/budget — the account's whole-life
// budget in dollars; empty clears it.
export async function subscriptionBudget(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const raw = field(form, "budget").trim();
  const usd = raw === "" ? null : Number(raw);
  const held = budgetsOf(ctx.app.db).get(ctx.params.id ?? "");
  if (held?.locked && (usd === null || !(usd < (held.budgetUsd ?? 0))))
    return flashTo(ctx, POOL, {
      tone: "danger",
      message:
        "This budget was set by whoever made this forge: it can be lowered here, never raised or cleared. Add your own key to spend more.",
    });
  const saved = usd !== null && !Number.isFinite(usd) ? false : setBudget(ctx.app.db, ctx.params.id ?? "", usd);
  return flashTo(
    ctx,
    POOL,
    saved
      ? { message: usd === null ? "No budget: this account spends until you stop it." : `Budget set: ${dollars(usd)} in all.` }
      : { tone: "danger", message: `A budget is dollars from 1 to ${limitValue(ctx.app.db, "subscription.budget_max_usd")}, or empty for none.` },
  );
}

const dollars = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

// POST /settings/subscriptions/:id/headroom
export async function subscriptionHeadroom(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const pct = headroomPct(field(form, "headroom"));
  if (pct === undefined)
    return flashTo(ctx, POOL, {
      tone: "danger",
      message: SUBSCRIPTION_WORDS.headroom_range,
    });
  const saved = setHeadroom(ctx.app.db, ctx.params.id ?? "", pct);
  return flashTo(
    ctx,
    POOL,
    saved
      ? {
          message: `The crew now leaves ${pct}% of each window for people.`,
        }
      : { tone: "danger", message: SUBSCRIPTION_WORDS.not_found },
  );
}

// ---- grants, on a repository's Crew settings and an organization's page ----

/**
 * The table an admin ticks: one row for everyone on the crew and one per
 * agent, one column per account. A row with nothing ticked has no grant of
 * its own, and the wider one applies. Rendered only for a forge admin.
 */
export function grantsSection(
  ctx: Ctx,
  o: {
    scopeId: string;
    agents: readonly Agent[];
    action: string;
    /** What applies to a row with nothing ticked, in a few words. */
    wider: string;
    title?: string | undefined;
  },
): Html {
  const pool = listSubscriptions(ctx.app.db);
  const head = html`${icon("key")}
    <h2>${o.title ?? "Subscriptions"}</h2>`;
  if (pool.length === 0)
    return card(
      html`<p class="muted small">
        Runs here work on the forge's own token. Add a subscription under
        <a href="${POOL}">Settings → Subscriptions</a> to spend a particular
        account here.
      </p>`,
      { head },
    );
  const granted = new Set(
    listGrants(ctx.app.db, o.scopeId).map(
      (g) => `${g.agentId}:${g.subscriptionId}`,
    ),
  );
  const line = (agentId: string, label: Html): Html =>
    html`<tr>
      <th scope="row">${label}</th>
      ${pool.map(
        (s) =>
          html`<td>
            <label class="check"
              ><input
                type="checkbox"
                name="grant"
                value="${agentId === EVERYONE ? "*" : agentId}:${s.id}"
                aria-label="${s.name} for ${agentId === EVERYONE
                  ? "everyone"
                  : label}"
                ${granted.has(`${agentId}:${s.id}`) ? html`checked` : null}
            /></label>
          </td>`,
      )}
    </tr>`;
  return html`<form method="post" action="${o.action}">
    ${card(
      html`<div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th></th>
              ${pool.map((s) => html`<th scope="col">${s.name}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${line(EVERYONE, html`Everyone on the crew`)}
            ${o.agents.map((a) => line(a.user.id, html`${a.user.username}`))}
          </tbody>
        </table>
      </div>`,
      {
        head,
        pad: false,
        foot: html`${btn("Save", { variant: "primary", size: "sm" })}
          <span class="muted small"
            >Two ticked on one row take turns. Nothing ticked means the wider
            grant applies: ${o.wider}.</span
          >`,
      },
    )}
  </form>`;
}

/**
 * Read a grants table back. Only the rows offered — everyone and the agents
 * given — are written, so a form cannot plant a grant for anyone else.
 */
export function saveGrants(
  ctx: Ctx,
  form: Form,
  scopeId: string,
  agents: readonly Agent[],
): void {
  const ticked = new Map<string, string[]>();
  for (const value of form.getAll("grant")) {
    if (typeof value !== "string") continue;
    const at = value.indexOf(":");
    if (at <= 0) continue;
    const who = value.slice(0, at);
    const agentId = who === "*" ? EVERYONE : who;
    ticked.set(agentId, [...(ticked.get(agentId) ?? []), value.slice(at + 1)]);
  }
  const rows = [EVERYONE, ...agents.map((a) => a.user.id)];
  for (const agentId of rows)
    setGrants(ctx.app.db, scopeId, agentId, ticked.get(agentId) ?? []);
}

/** Every agent on the forge — the rows of an organization's table. */
export function agentsOnForge(ctx: Ctx): Agent[] {
  return listAgents(ctx.app.db);
}
