/**
 * Apps on the web (docs/APPS.md): the list, the golden path's first step
 * (New app), the three things you can do to an environment — open,
 * redeploy, stop — and the two pieces other pages borrow: the strip a repo
 * home wears when it runs, and the preview card a pull carries. An app's
 * own page is the studio's (`studio/app.ts`); its old dev URL redirects.
 *
 * Every mutation is an action; a page only puts its answer into words.
 * Opening an environment goes through `openEnvUrl`, which is what makes a
 * private app work: the forge checks `canRead`, signs a short-lived grant,
 * and sends the visitor on — a link straight to the hostname would be a
 * 404 for everyone.
 */

import { storageLimitMessage } from "../../core/storage.ts";
import { repositoryLimitMessage } from "../../actions/repos.ts";
import { appLimitWords } from "../../actions/app_limit.ts";
import { getUserByName } from "../../core/users.ts";
import {
  NEW_APP_ERRORS,
  NO_NAME_ERROR,
  appView,
  newApp,
  newAppFromSentence,
  type NewAppResult,
  openEnvUrl,
  redeployEnv,
  stopEnv,
  terminalFor,
} from "../../actions/apps.ts";
import { listAllAgents } from "../../actions/crew.ts";
import { planningAvailable } from "../../crew/plan.ts";
import { appNameJs } from "./apps-name.ts";
import { STARTERS, starterFromQuery, starterHref } from "./apps-starters.ts";
import { previewEnv, type EnvName } from "../../apps/data.ts";
import { envRefusalText, redeployedText, stoppedText } from "../../actions/env_words.ts";
import { appsRuntime, type EnvStatus, envsFor } from "../../apps/runtime.ts";
import { firstPreviews, goldenPath, goldenPathLine } from "../../apps/golden_path.ts";
import { appHostSuffix } from "../../apps/host.ts";
import { appsForRepos, getAppByRepo, type AppRecord } from "../../core/apps.ts";
import { shownProduction } from "../../core/forge_repo.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import type { Pull } from "../../core/pulls.ts";
import {
  canAdmin,
  canWrite,
  getRepoById,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { safeBack, type Ctx } from "../../http/context.ts";
import {
  nameFrame,
  notePhase,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
} from "../../core/route_timing.ts";
import { isHostPort, resolveAppHostname } from "../../apps/proxy.ts";
import {
  loadRepo,
  notFoundPage,
  pageHead,
  repoBase,
  signInFirst,
  NOT_YOURS_TO_DO,
  forbiddenPage,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { writableAppsOf } from "../studio/asks.ts";
import { costLine } from "../studio/cost_line.ts";
import { homeTabs, unshippedAsks } from "../studio/home_tabs.ts";
import { shelfRows } from "../studio/shelf.ts";
import {
  badge,
  btn,
  card,
  empty,
  envFacts,
  envStateBadge,
  icon,
  previewDataNote,
  seg,
  selectField,
  sha,
  terminalLine,
  field as formField,
} from "../ui.ts";

// ---- what the viewer can see ----

interface AppEntry {
  readonly record: AppRecord;
  readonly repo: Repo;
  readonly production: EnvStatus | undefined;
  readonly previews: number;
  /** Production's public URL, or undefined when nothing serves apps. */
  readonly url: string | undefined;
}

/**
 * Every app the viewer may see, newest first, with what production is
 * doing. Visibility is decided in SQL by `listReposVisibleTo` — exactly the
 * TUI's `listVisibleApps` — never by calling `canRead` once per app: that
 * would cost a query per row for any repo the viewer does not own outright
 * (`canRead` resolves org ownership from the database), and a listing must
 * not get slower as the forge grows more apps.
 */
function appsForViewer(ctx: Ctx, archived: boolean): AppEntry[] {
  const repos = listReposVisibleTo(
    ctx.app.db,
    ctx.auth.user,
    archived ? { limit: 200, archivedOnly: true } : { limit: 200, withoutArchived: true },
  );
  const records = appsForRepos(
    ctx.app.db,
    repos.map((repo) => repo.id),
  );
  const runtime = appsRuntime(ctx.app);
  const out: AppEntry[] = [];
  for (const repo of repos) {
    const record = records.get(repo.id);
    if (record === undefined) continue;
    const envs = envsFor(ctx.app, ctx.auth.user, record);
    out.push({
      record,
      repo,
      production: envs.find((env) => env.env === "production"),
      previews: envs.filter((env) => env.env !== "production").length,
      url: shownProduction(ctx.app, repo, runtime?.urlFor(record, "production")).url,
    });
  }
  return out;
}

/** How many archived apps the viewer can see (the "N archived" line). */
export function archivedAppCount(ctx: Ctx): number {
  const repos = listReposVisibleTo(ctx.app.db, ctx.auth.user, {
    limit: 200,
    archivedOnly: true,
  });
  return appsForRepos(
    ctx.app.db,
    repos.map((repo) => repo.id),
  ).size;
}

/** The archived list's Wake: a small form under each row the viewer administers. */
function wakeForms(ctx: Ctx, repos: readonly Repo[]): Map<string, Html> {
  const out = new Map<string, Html>();
  for (const repo of repos) {
    if (!canAdmin(ctx.app.db, repo, ctx.auth.user)) continue;
    out.set(
      repo.id,
      html`<li>
        <form method="post" action="${repoBase(repo)}/settings/archive">
          <input type="hidden" name="archived" value="0" />
          <input type="hidden" name="to" value="/apps?archived=1" />
          ${btn(html`Wake<span class="sr-only"> ${repo.ownerName}/${repo.name}</span>`)}
        </form>
      </li>`,
    );
  }
  return out;
}

/**
 * GET /apps: every app the viewer can land, for every viewer, drawn as the
 * shelf (`shelfRows`, `studio/shelf.ts`) — the same row the home's *Your
 * apps* card draws, never a second copy of it. `?live=1` is a link, not a
 * form, narrowing the shelf to what production is actually serving; with
 * neither filter it's every app, newest first. Visibility and the owner's
 * facts are exactly `appsForViewer`'s and `shelfRows`'s own — a signed-out
 * viewer gets the public shelf, and a reader who cannot write to an app
 * never sees its crew or its cost.
 */
export async function appsList(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  // Archived apps are put away, not gone: `?archived=1` lists only them. Each
  // view reads its own window, so archived repos never push live ones off.
  const archivedView = ctx.url.searchParams.get("archived") === "1";
  const entries = timePhase(ctx.request, "apps", () =>
    appsForViewer(ctx, archivedView),
  );
  const archivedCount = archivedView
    ? 0
    : timePhase(ctx.request, "archived", () => archivedAppCount(ctx));
  const liveCount = entries.filter(
    (e) => e.production?.state === "running",
  ).length;
  const live = !archivedView && ctx.url.searchParams.get("live") === "1";
  const shown = live
    ? entries.filter((e) => e.production?.state === "running")
    : entries;
  const create = ctx.auth.user
    ? btn("New app", {
        href: "/apps/new",
        variant: "primary",
        size: "sm",
        icon: "plus",
        shortcut: "c",
      })
    : btn("Sign in to make one", { href: "/signin", size: "sm" });
  const filters =
    archivedView || entries.length === 0
      ? null
      : html`<div class="bar mb">
          ${seg([
            {
              label: "All",
              href: "/apps",
              current: !live,
              count: entries.length,
            },
            {
              label: "Live",
              href: "/apps?live=1",
              current: live,
              count: liveCount,
            },
          ])}
        </div>`;
  const wake = archivedView ? wakeForms(ctx, shown.map((e) => e.repo)) : undefined;
  const rows = await timePhaseAsync(ctx.request, "shelf", () =>
    shelfRows(
      ctx,
      shown.map((e) => e.repo),
      { firstPreview: firstPreviews(ctx.app.db, shown.map((e) => e.record)), under: wake },
    ),
  );
  const cost = timePhase(ctx.request, "cost", () =>
    costLine(ctx.app.db, writableAppsOf(ctx, ctx.auth.user).repos),
  );
  const rendering = performance.now();
  const body = html`<div data-apps-page>${when(ctx.auth.user, (user) => homeTabs("apps", unshippedAsks(ctx.app.db, user)))}
    ${pageHead("Apps", { actions: create })}
    ${cost}
    ${filters}
    ${archivedView
      ? html`<p class="muted small mb"><a href="/apps">Back to apps</a></p>`
      : archivedCount > 0
        ? html`<p class="muted small mb">
            <a href="/apps?archived=1">${archivedCount} archived</a>
          </p>`
        : null}
    ${shown.length === 0
      ? empty({
          icon: "rocket",
          title: archivedView
            ? "Nothing is archived"
            : live
              ? "Nothing is live"
              : "Nothing runs here yet",
          note: live
            ? "Nothing is serving right now — clear the filter to see every app."
            : "A new app is a repository with a small working app in it, served at its own hostname a few seconds later.",
          action: create,
        })
      : card(html`<ul class="list setting-list">${rows}</ul>`, { pad: false })}</div>`;
  const response = page({ ctx, title: "Apps", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// ---- new app ----

interface NewAppValues {
  owner: string;
  name: string;
  description: string;
  visibility: string;
  agent: string;
}

/** The agent select's sentinel for "turn the sentence into a plan and pick". */
const PICK_AGENT = "__pick__";

/** Whether the form can offer "pick for me": the planner is on the path (timed as `planner`). */
function plannerOffered(ctx: Ctx): boolean {
  return timePhase(ctx.request, "planner", () =>
    planningAvailable(process.env["FORGE_CLAUDE"] ?? "claude"),
  );
}

function newAppForm(
  ctx: Ctx,
  values: NewAppValues,
  canPlan: boolean,
  error?: string,
): Html {
  const user = ctx.auth.user!;
  const writeOrgs = timePhase(ctx.request, "orgs", () =>
    listOrgsForUser(ctx.app.db, user.id).filter((org) =>
      accessAllows(orgAccess(ctx.app.db, org.id, user), "write"),
    ),
  );
  const owners = [user.username, ...writeOrgs.map((o) => o.username)];
  const agents = timePhase(ctx.request, "agents", () =>
    listAllAgents(ctx.app, user),
  );
  const crew = agents.ok ? agents.value : [];
  const domain = appsRuntime(ctx.app)?.options.domain;

  // An org's form stays the org's: carry the owner only when it is one the
  // select offers, and only when it is not the viewer's own default.
  const carried =
    values.owner !== user.username && owners.includes(values.owner)
      ? values.owner
      : undefined;

  return html`<div class="narrow-wide">
    ${pageHead("New app", {
      sub: "A repository with a small working app in it: a first issue from your sentence, a crew member on it, production at its hostname, and a preview for every change.",
    })}
    ${card(
      html`<form method="post" action="/apps/new">
        ${formField({
          label: "What should it do?",
          name: "description",
          type: "textarea",
          rows: 3,
          value: values.description,
          required: true,
          autofocus: true,
          hint: "A sentence is enough — it becomes the first issue, and the agent you pick below starts on it.",
        })}
        <div class="stack mb" role="group" aria-labelledby="starters-label">
          <span id="starters-label" class="muted small"
            >No idea where to start? Tap a starter to fill the box:</span
          >
          ${STARTERS.map((s) =>
            btn(s, {
              href: starterHref(s, carried),
              variant: "outline",
              size: "lg",
            }),
          )}
        </div>
        ${selectField({
          label: "Owner",
          name: "owner",
          options: owners.map((o) => ({
            value: o,
            label: o,
            selected: o === values.owner,
          })),
        })}
        ${formField({
          label: "Name",
          name: "name",
          value: values.name,
          pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
          hint:
            domain === undefined
              ? "Left blank, it's made from your sentence above. Letters, digits, dots, dashes and underscores; the hostname is made from it."
              : `Left blank, it's made from your sentence above. Letters, digits, dots, dashes and underscores; it runs at <name>${appHostSuffix(domain)}.`,
          ...(error ? { error } : {}),
        })}
        ${selectField({
          label: "Visibility",
          name: "visibility",
          hint: "A private app answers only to people who can see its repository; the forge vouches for them on the way in.",
          options: [
            {
              value: "private",
              label: "Private",
              selected: values.visibility !== "public",
            },
            {
              value: "public",
              label: "Public",
              selected: values.visibility === "public",
            },
          ],
        })}
        ${crew.length === 0
          ? html`<p class="muted small mb">
              ${icon("bot")} No agents on this forge yet, so this app has no
              crew to hand the first issue to.
              ${user.isAdmin
                ? html`Create one under
                    <a href="/settings/crew">Settings → Crew</a>.`
                : html`An admin can create one under account settings → Crew.`}
            </p>`
          : selectField({
              label: "Agent",
              name: "agent",
              hint: canPlan
                ? "Pick for me turns the sentence into a checklist and picks who's likeliest to do it well. Otherwise it joins the crew and, with a sentence, gets the first issue."
                : "Joins the crew of the new app. With a sentence above, it gets the first issue and starts on it.",
              options: [
                ...(canPlan
                  ? [
                      {
                        value: PICK_AGENT,
                        label: "Pick for me",
                        selected: values.agent === PICK_AGENT,
                      },
                    ]
                  : []),
                {
                  value: "",
                  label: "Nobody — I'll build it myself",
                  selected: values.agent === "",
                },
                ...crew.map((agent) => ({
                  value: agent.user.username,
                  label:
                    agent.model === ""
                      ? agent.user.username
                      : `${agent.user.username} — ${agent.model}`,
                  selected: values.agent === agent.user.username,
                })),
              ],
            })}
        <div class="form-actions">
          ${btn("Create app", { variant: "primary", icon: "rocket" })}
          ${btn("Cancel", { href: "/apps", variant: "ghost" })}
        </div>
      </form>`,
    )}
    <p class="muted">Already have an app on another forge? <a href="/bring">Bring it here whole</a>.</p>
  </div>`;
}

// GET /apps/new
export function newAppPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const picks = plannerOffered(ctx);
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "New app",
    body: newAppForm(ctx, {
      owner: ctx.url.searchParams.get("owner") ?? ctx.auth.user.username,
      name: "",
      description: starterFromQuery(ctx.url.searchParams.get("description")),
      visibility: "private",
      agent: picks ? PICK_AGENT : "",
    }, picks),
    scriptJs: appNameJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /apps/new
export async function newAppSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const phase = (name: string, ms: number) => notePhase(ctx.request, name, ms);
  const values: NewAppValues = {
    owner: field(form, "owner"),
    name: field(form, "name"),
    description: field(form, "description"),
    visibility: field(form, "visibility") === "public" ? "public" : "private",
    agent: field(form, "agent"),
  };
  const pickAgent = values.agent === PICK_AGENT;
  // An explicit name is never second-guessed; left blank, the sentence
  // names the app — and the server derives that name itself (never trusting
  // whatever the field carried in): the field is only a client-side preview.
  const explicitName = values.name.trim();
  const rest = {
    owner: values.owner,
    visibility: values.visibility === "public" ? "public" : "private",
    ...(pickAgent
      ? { pickAgent: true }
      : values.agent === ""
        ? {}
        : { agent: values.agent }),
  } as const;
  const made: { ok: true; value: NewAppResult } | { ok: false; error: string } =
    explicitName === ""
      ? await newAppFromSentence(
          ctx.app,
          ctx.auth.user,
          { ...rest, sentence: values.description },
          phase,
        ).then((r) => (r.ok ? { ok: true as const, value: r } : { ok: false as const, error: r.code }))
      : await newApp(
          ctx.app,
          ctx.auth.user,
          { ...rest, description: values.description, name: explicitName },
          phase,
        );
  if (!made.ok && made.error === "no_name") {
    return page(
      {
        ctx,
        title: "New app",
        body: newAppForm(ctx, values, plannerOffered(ctx), NO_NAME_ERROR),
        scriptJs: appNameJs,
      },
      422,
    );
  }
  if (!made.ok) {
    if (made.error === "forbidden_owner" || made.error === "unauthorized")
      return forbiddenPage(ctx, NOT_YOURS_TO_DO);
    const ownerId = getUserByName(
      ctx.app.db,
      values.owner || ctx.auth.user.username,
    )?.id;
    return page(
      {
        ctx,
        title: "New app",
        body: newAppForm(
          ctx,
          values,
          plannerOffered(ctx),
          made.error === "repository_limit"
            ? `Not made: ${repositoryLimitMessage(ctx.app, ctx.auth.user!)}.`
            : made.error === "storage_limit"
            ? `Not made: ${storageLimitMessage(ctx.app, ctx.auth.user!.id)}.`
            : made.error === "app_limit" && ownerId !== undefined
            ? appLimitWords(ctx.app, ownerId)
            : (NEW_APP_ERRORS[made.error] ?? "That app could not be created."),
        ),
        scriptJs: appNameJs,
      },
      422,
    );
  }
  const { repo, app: record, issue, plan } = made.value;
  const url = appsRuntime(ctx.app)?.urlFor(record, "production");
  const first =
    url === undefined
      ? `${repo.name} is an app, but nothing is serving apps on this forge.`
      : `${repo.name} is starting at ${url}.`;
  const second =
    issue === undefined
      ? ""
      : issue.assigneeName === null
        ? ` #${issue.number} is waiting for someone.`
        : plan
          ? ` ${plan.agent} was picked for #${issue.number} — ${plan.summary}`
          : ` #${issue.number} is assigned to ${issue.assigneeName}.`;
  // The repository's home is the app page (repoHome), once the record
  // exists; the code is its Files step.
  return flashTo(ctx, repoBase(repo), { message: `${first}${second}` });
}

// ---- the repo home's strip ----

/**
 * The forge's own source runs a test copy of the forge (`shownProduction`):
 * named plainly as one, and opened through `/apps/open`, which signs the
 * visitor in to it as any app host does.
 */
export function testCopyLink(url: string): Html {
  const host = new URL(url).host;
  return html`<span class="muted"
    >Test copy:
    <a class="mono" href="/apps/open?host=${encodeURIComponent(host)}" title="A copy of the forge for testing, not production"
      >${host}</a
    ></span
  >`;
}

/**
 * One line under the repo header, for a repository that runs: production's
 * state, the commit it serves, its URL, how many previews are up, and the
 * way to the app's page in the studio, where its environments are run.
 * Nothing for a repository that is not an app.
 */
export function appStrip(ctx: Ctx, repo: Repo): Html {
  const view = appView(ctx.app, ctx.auth.user, repo);
  if (!view.ok) return html``;
  const { app: record, environments, serving } = view.value;
  const base = repoBase(repo);
  const production = environments.find((env) => env.env === "production");
  const previews = environments.length - (production === undefined ? 0 : 1);
  const { url, copy } = shownProduction(ctx.app, repo, appsRuntime(ctx.app)?.urlFor(record, "production"));
  const pace = goldenPathLine(goldenPath(ctx.app.db, record));
  return html`<div class="app-strip">
    ${icon("rocket")}
    ${serving
      ? envStateBadge(production?.state ?? "stopped")
      : badge("Not serving", { variant: "outline" })}
    ${when(production !== undefined && production.commitOid !== "", () =>
      sha(production!.commitOid, `${base}/commit/${production!.commitOid}`),
    )}
    ${when(
      url,
      (u) =>
        html`<a
          class="mono truncate"
          href="${base}/app/production/open"
          title="Open ${u}"
          >${u}</a
        >`,
    )}
    ${when(copy, (c) => testCopyLink(c))}
    ${when(
      previews > 0,
      () =>
        html`<span class="muted"
          >${previews} preview${previews === 1 ? "" : "s"}</span
        >`,
    )}
    ${when(pace, (line) => html`<span class="muted">${line}</span>`)}
  </div>`;
}

// ---- the app page ----

/**
 * Where an app's page is: the studio's (`studio/app.ts`), the repository's
 * home for every viewer. Its code is one tab deeper, the Files step
 * (`repoFiles`, `pages/repo.ts`).
 */
export function appHref(repo: Repo): string {
  return repoBase(repo);
}

// GET /:owner/:name/app — dev's App page, folded into the studio's (#395).
// The old URL keeps answering: a reader of an app is sent to the studio app
// page; anyone else gets the same not-found the page always gave them.
export function appPage(ctx: Ctx): Response {
  const req = ctx.request;
  notePhase(req, "session", takeSessionTime(req));
  const repo = timePhase(req, "repo", () => loadRepo(ctx));
  const seen = repo !== undefined && timePhase(req, "view", () => appView(ctx.app, ctx.auth.user, repo).ok);
  const rendering = performance.now();
  const response = !repo || !seen
    ? notFoundPage(ctx)
    : new Response(null, {
        status: 302,
        headers: { location: appHref(repo), "cache-control": "no-store" },
      });
  notePhase(req, "render", performance.now() - rendering);
  return response;
}

// ---- the pull page's preview card ----

/** Where this pull's preview stands, with the way in. */
export function previewCard(ctx: Ctx, repo: Repo, pull: Pull): Html {
  const view = appView(ctx.app, ctx.auth.user, repo);
  if (!view.ok) return html``;
  const base = repoBase(repo);
  const env = view.value.environments.find(
    (e) => e.env === previewEnv(pull.number),
  );
  const head = html`${icon("rocket")}
    <h2>Preview</h2>
    ${env === undefined ? null : envStateBadge(env.state, env.dormant !== undefined)}`;
  if (!view.value.serving)
    return card(
      html`<p class="muted small">Nothing is serving apps on this forge.</p>`,
      { head },
    );
  if (env === undefined) {
    const why =
      pull.mergedAt !== null
        ? "The preview and its data were removed when this merged."
        : pull.state === "closed"
          ? "The preview was removed when this closed. Reopen the pull request and it comes back."
          : "No preview yet — one starts when this pull request's head deploys.";
    return card(html`<p class="muted small">${why}</p>`, { head });
  }
  // A preview's terminal is a different login from production's — its own
  // command, shown only to a writer, same as the app page's.
  const writer = canWrite(ctx.app.db, repo, ctx.auth.user);
  const dataNote = previewDataNote(view.value.app.previewData, pull.createdAt);
  return card(
    html`${envFacts(base, env)}
      ${dataNote === null ? null : html`<p class="muted small">${dataNote}</p>`}
      ${when(writer, () =>
        terminalLine(
          terminalFor(ctx.app, view.value.app, env.env, env),
          ctx.app.config.sshHostKey,
        ),
      )}
      <div class="bar mt">
        ${env.dormant !== undefined && writer
          ? html`<form method="post" action="${base}/app/${env.env}/redeploy">
              ${btn("Wake it", { size: "sm", icon: "play" })}
            </form>`
          : btn("Open preview", {
              href: `${base}/app/${env.env}/open`,
              size: "sm",
              variant: "outline",
              icon: "external",
            })}
      </div>`,
    {
      head,
      extra: "env-card",
      ...(env.state === "failed" || env.error !== undefined
        ? { tone: "danger" as const }
        : env.failedDeploy !== undefined
          ? { tone: "attn" as const }
          : {}),
    },
  );
}

// ---- environment routes ----

// GET /:owner/:name/app/:env/open — through the forge, so a private app
// gets its grant; a plain link to the hostname would 404 for everyone.
/**
 * GET /apps/open?host=…&to=… — where a private app sends a person who
 * arrived by its link. Signed in (the edge, or the forge's own door), they
 * are vouched for if they can see the repository and sent back with the
 * grant; otherwise they get what a private repository gives a stranger.
 * The repository is never named on this path: the hostname was already
 * theirs, nothing else is.
 */
export function appsOpen(ctx: Ctx): Response {
  nameFrame(ctx.request);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "render", () => appsOpenResponse(ctx));
}

function appsOpenResponse(ctx: Ctx): Response {
  const runtime = appsRuntime(ctx.app);
  const host = (ctx.url.searchParams.get("host") ?? "").trim();
  const wanted = ctx.url.searchParams.get("to") ?? "/";
  const path =
    wanted.startsWith("/") && !wanted.startsWith("//") ? wanted : "/";
  if (runtime === undefined || !isHostPort(host)) return notFoundPage(ctx);
  const target = resolveAppHostname(ctx.app, runtime.options.domain, host);
  if (target === undefined || target === "unknown") return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const repo = getRepoById(ctx.app.db, target.app.repoId);
  if (!repo) return notFoundPage(ctx);
  const link = openEnvUrl(ctx.app, ctx.auth.user, repo, target.env, path, host);
  if (!link.ok) return notFoundPage(ctx);
  return new Response(null, {
    status: 302,
    headers: { location: link.value, "cache-control": "no-store" },
  });
}

export function appOpen(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  // The forge's own source: its production is the forge, not the test copy.
  const env = ctx.params.env ?? "";
  const record = env === "production" ? getAppByRepo(ctx.app.db, repo.id) : undefined;
  const shown = record === undefined ? undefined : shownProduction(ctx.app, repo, appsRuntime(ctx.app)?.urlFor(record, "production"));
  if (shown?.copy !== undefined && shown.url !== undefined)
    return new Response(null, { status: 302, headers: { location: shown.url, "cache-control": "no-store" } });
  const link = openEnvUrl(ctx.app, ctx.auth.user, repo, env);
  if (!link.ok) {
    if (link.error === "unauthorized") return signInFirst(ctx);
    if (link.error === "no_runtime")
      return flashTo(ctx, repoBase(repo), {
        tone: "attn",
        message: "Nothing is serving apps on this forge.",
      });
    return notFoundPage(ctx);
  }
  return new Response(null, {
    status: 302,
    headers: { location: link.value, "cache-control": "no-store" },
  });
}

/** The gate every environment POST passes: a readable repo, a signed-in writer-scope form. */
async function envForm(
  ctx: Ctx,
): Promise<{ repo: Repo; env: string; user: User } | Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  return { repo, env: ctx.params.env ?? "", user: ctx.auth.user };
}

/**
 * Where an environment form sends the person who pressed it: the page the
 * form was on — the app's own page, a change's, a pull's — because the head
 * card refreshes itself on the deploy event (`appStateFragment`,
 * `GET /:owner/:name/app/state`), so staying put shows the result better
 * than any page a redirect could pick. The page comes from the referer, and
 * only when the referer is this forge's own origin (`safeBack`), never from
 * a form field; with no referer the fallback is the repository's home.
 */
function envBack(ctx: Ctx, repo: Repo): string {
  // Arriving from the confirm page, going "back" would ask again; the
  // repository's page is where the person can see what changed.
  const back = safeBack(ctx);
  if (back === undefined || back.split("?")[0] === "/-/confirm")
    return repoBase(repo);
  return back;
}

function envFailure(ctx: Ctx, repo: Repo, error: string): Response {
  if (error === "not_found" || error === "no_such_env")
    return notFoundPage(ctx);
  return flashTo(ctx, envBack(ctx, repo), {
    tone: "danger",
    message: envRefusalText(error),
  });
}

// POST /:owner/:name/app/:env/redeploy
export async function appRedeploy(ctx: Ctx): Promise<Response> {
  const gate = await envForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, env, user } = gate;
  const queued = await redeployEnv(ctx.app, user, repo, env);
  if (!queued.ok) return envFailure(ctx, repo, queued.error);
  const run = queued.value;
  // The page that asked for it stays put and watches the head card change
  // there (`envBack`); the run itself is one link away on that card.
  return redirect(envBack(ctx, repo), {
    url: ctx.url,
    forgeUrl: ctx.app.config.url,
    flash: { message: redeployedText(env as EnvName, run) },
  });
}

// POST /:owner/:name/app/:env/stop
export async function appStop(ctx: Ctx): Promise<Response> {
  const gate = await envForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, env, user } = gate;
  const stopped = await stopEnv(ctx.app, user, repo, env);
  if (!stopped.ok) return envFailure(ctx, repo, stopped.error);
  return flashTo(ctx, envBack(ctx, repo), {
    message: stoppedText(env as EnvName),
  });
}
