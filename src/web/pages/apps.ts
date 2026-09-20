/**
 * Apps on the web (docs/APPS.md): the list, the golden path's first step
 * (New app), one app's environments with the three things you can do to
 * one — open, redeploy, stop — and the two pieces other pages borrow: the
 * strip a repo home wears when it runs, and the preview card a pull carries.
 *
 * Every mutation is an action; a page only puts its answer into words.
 * Opening an environment goes through `openEnvUrl`, which is what makes a
 * private app work: the forge checks `canRead`, signs a short-lived grant,
 * and sends the visitor on — a link straight to the hostname would be a
 * 404 for everyone.
 */

import {
  appView,
  newApp,
  openEnvUrl,
  redeployEnv,
  stopEnv,
  terminalFor,
} from "../../actions/apps.ts";
import { listAllAgents, listCrew } from "../../actions/crew.ts";
import { planningAvailable } from "../../crew/plan.ts";
import { appNameJs, deriveAppName } from "./apps-name.ts";
import { listRepoRuns } from "../../actions/runs.ts";
import { envPull, previewEnv, type EnvName } from "../../apps/data.ts";
import { appsRuntime, type EnvStatus } from "../../apps/runtime.ts";
import { appHostSuffix } from "../../apps/host.ts";
import { appsForRepos, type AppRecord } from "../../core/apps.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import type { Pull } from "../../core/pulls.ts";
import {
  canAdmin,
  canWrite,
  getRepoById,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import { isTerminal } from "../../core/runs.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { resolveAppHostname } from "../../apps/proxy.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  pageHead,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { shelfRows } from "../studio/shelf.ts";
import { studioCss } from "../studio/style.ts";
import {
  badge,
  btn,
  card,
  dot,
  empty,
  envActions,
  envFacts,
  envStateBadge,
  envTone,
  icon,
  listCard,
  row,
  seg,
  selectField,
  sha,
  terminalLine,
  time,
  userLink,
  field as formField,
} from "../ui.ts";
import { actorsFor, issuesFor, runRow } from "./runs.ts";

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
function appsForViewer(ctx: Ctx): AppEntry[] {
  const repos = listReposVisibleTo(ctx.app.db, ctx.auth.user, { limit: 200 });
  const records = appsForRepos(
    ctx.app.db,
    repos.map((repo) => repo.id),
  );
  const runtime = appsRuntime(ctx.app);
  const out: AppEntry[] = [];
  for (const repo of repos) {
    const record = records.get(repo.id);
    if (record === undefined) continue;
    const envs = runtime === undefined ? [] : runtime.status(record);
    out.push({
      record,
      repo,
      production: envs.find((env) => env.env === "production"),
      previews: envs.filter((env) => env.env !== "production").length,
      url: runtime?.urlFor(record, "production"),
    });
  }
  return out;
}

/** `production` or `preview of #12`, as a phrase that fits in a sentence. */
export function envLabel(env: EnvName): string {
  const number = envPull(env);
  return number === undefined ? "production" : `preview of #${number}`;
}

/**
 * One app in a list. The dot is production's state; the title goes to the
 * App page and the URL opens the app — two links, so the row is not itself
 * one (a link inside a link tears the row apart).
 */
function appRow(entry: AppEntry): Html {
  const base = repoBase(entry.repo);
  const name = `${entry.repo.ownerName}/${entry.repo.name}`;
  return row({
    nav: true,
    lead: dot(envTone(entry.production?.state)),
    title: html`<a href="${base}/app">${name}</a>`,
    titleAttr: name,
    meta: html`${entry.url === undefined
      ? html`<span>not serving</span>`
      : html`<a href="${base}/app/production/open" title="Open ${entry.url}"
          >${entry.url}</a
        >`}${when(
      entry.previews > 0,
      () =>
        html` · ${entry.previews} preview${entry.previews === 1 ? "" : "s"}`,
    )}`,
    trail: html`${when(
      entry.repo.visibility === "private",
      () =>
        html`<span class="badge" data-variant="secondary"
          >${icon("lock")}Private</span
        >`,
    )}`,
  });
}

/** The dashboard's Apps card: what runs, and the button that makes one. */
export function appsCard(ctx: Ctx): Html {
  const entries = appsForViewer(ctx);
  const head = html`${icon("rocket")}
    <h2>Apps</h2>
    <span class="spacer"></span>
    ${btn("Map", { href: "/map", size: "sm", icon: "map" })}
    ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}`;
  if (entries.length === 0) {
    return card(
      html`<p class="muted small">
        An app is a repository that runs — here, with a URL in seconds and a
        preview for every pull request.
      </p>`,
      { head },
    );
  }
  const shown = entries.slice(0, 8);
  return listCard(shown.map(appRow), {
    head,
    ...(entries.length > shown.length
      ? {
          foot: html`<a href="/apps"
            >All ${entries.length} apps ${icon("chevronRight")}</a
          >`,
        }
      : {}),
  });
}

// GET /apps
export async function appsList(ctx: Ctx): Promise<Response> {
  // In the studio, the same list a person's home links to is the shelf,
  // not dev's table — `?mode=dev` still renders what follows, unchanged.
  if (ctx.mode === "studio") return await studioAppsList(ctx);
  const entries = appsForViewer(ctx);
  const create = ctx.auth.user
    ? btn("New app", {
        href: "/apps/new",
        variant: "primary",
        size: "sm",
        icon: "plus",
        shortcut: "c",
      })
    : btn("Sign in to make one", { href: "/signin", size: "sm" });
  const body = html`${pageHead("Apps", {
    actions: create,
    sub: "Repositories that run. Production follows the default branch; every open pull request gets a preview.",
  })}
  ${entries.length === 0
    ? empty({
        icon: "rocket",
        title: "Nothing runs here yet",
        note: "A new app is a repository with a small working app in it, served at its own hostname a few seconds later.",
        action: create,
      })
    : listCard(entries.map(appRow))}`;
  return page({ ctx, title: "Apps", body });
}

/**
 * GET /apps in the studio: every app the viewer can land, drawn as the
 * shelf (`shelfRows`, `studio/shelf.ts`) — the same row the home's *Your
 * apps* card draws, never a second copy of it. `?live=1` is a link, not a
 * form, narrowing the shelf to what production is actually serving; with
 * neither filter it's every app, newest first. Visibility and the owner's
 * facts are exactly `appsForViewer`'s and `shelfRows`'s own — a signed-out
 * viewer gets the public shelf, and a reader who cannot write to an app
 * never sees its crew or its cost.
 */
async function studioAppsList(ctx: Ctx): Promise<Response> {
  const entries = appsForViewer(ctx);
  const liveCount = entries.filter(
    (e) => e.production?.state === "running",
  ).length;
  const live = ctx.url.searchParams.get("live") === "1";
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
    entries.length === 0
      ? null
      : html`<div class="filters mb">
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
  const rows = await shelfRows(
    ctx,
    shown.map((e) => e.repo),
  );
  const body = html`${pageHead("Apps", { actions: create })}
    ${filters}
    ${shown.length === 0
      ? empty({
          icon: "rocket",
          title: live ? "Nothing is live" : "Nothing runs here yet",
          note: live
            ? "Nothing is serving right now — clear the filter to see every app."
            : "A new app is a repository with a small working app in it, served at its own hostname a few seconds later.",
          action: create,
        })
      : listCard(rows)}`;
  return page({ ctx, title: "Apps", body, styleCss: studioCss });
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

function newAppForm(ctx: Ctx, values: NewAppValues, error?: string): Html {
  const user = ctx.auth.user!;
  const writeOrgs = listOrgsForUser(ctx.app.db, user.id).filter((org) =>
    accessAllows(orgAccess(ctx.app.db, org.id, user), "write"),
  );
  const owners = [user.username, ...writeOrgs.map((o) => o.username)];
  const agents = listAllAgents(ctx.app, user);
  const crew = agents.ok ? agents.value : [];
  const domain = appsRuntime(ctx.app)?.options.domain;
  const canPlan = planningAvailable(process.env["FORGE_CLAUDE"] ?? "claude");

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
  </div>`;
}

// GET /apps/new
export function newAppPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return page({
    ctx,
    title: "New app",
    body: newAppForm(ctx, {
      owner: ctx.url.searchParams.get("owner") ?? ctx.auth.user.username,
      name: "",
      description: "",
      visibility: "private",
      agent: planningAvailable(process.env["FORGE_CLAUDE"] ?? "claude")
        ? PICK_AGENT
        : "",
    }),
    scriptJs: appNameJs,
  });
}

/** Nothing in the sentence a slug can carry: punctuation only, or a script `[a-z0-9]` cannot. */
const NO_NAME_ERROR =
  "That doesn't leave anything to make a name from — type one below.";

/** How many suffixed names (`x-2`, `x-3`, …) a derived name will try before giving up. */
const MAX_NAME_ATTEMPTS = 30;

const NEW_APP_ERRORS: Record<string, string> = {
  name_taken: "That owner already has a repository by that name.",
  invalid_name: "Names start with a letter or digit; no spaces, no .git.",
  git_init_failed: "The repository could not be initialised on disk.",
  invalid_slug:
    "That name makes no usable hostname — start it with a letter or digit.",
  slug_taken:
    "Another app already answers to that hostname. Pick another name.",
  already_app: "That repository is already an app.",
  scaffold_failed: "The starter app could not be committed.",
  no_such_agent: "That agent is not on this forge.",
};

// POST /apps/new
export async function newAppSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
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
  const base = explicitName === "" ? deriveAppName(values.description) : explicitName;
  if (base === undefined) {
    return page(
      {
        ctx,
        title: "New app",
        body: newAppForm(ctx, values, NO_NAME_ERROR),
        scriptJs: appNameJs,
      },
      422,
    );
  }
  const rest = {
    owner: values.owner,
    description: values.description,
    visibility: values.visibility === "public" ? "public" : "private",
    ...(pickAgent
      ? { pickAgent: true }
      : values.agent === ""
        ? {}
        : { agent: values.agent }),
  } as const;
  let made = await newApp(ctx.app, ctx.auth.user, { ...rest, name: base });
  // A derived name that collides tries `base-2`, `base-3`, … — the same
  // `name_taken` check an explicit name gets, just run more than once.
  for (
    let n = 2;
    explicitName === "" && !made.ok && made.error === "name_taken" && n <= MAX_NAME_ATTEMPTS;
    n++
  ) {
    made = await newApp(ctx.app, ctx.auth.user, {
      ...rest,
      name: `${base}-${n}`,
    });
  }
  if (!made.ok) {
    if (made.error === "forbidden_owner" || made.error === "unauthorized")
      return new Response("forbidden", { status: 403 });
    return page(
      {
        ctx,
        title: "New app",
        body: newAppForm(
          ctx,
          values,
          NEW_APP_ERRORS[made.error] ?? "That app could not be created.",
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
    issue === undefined || issue.assigneeName === null
      ? ""
      : plan
        ? ` ${plan.agent} was picked for #${issue.number} — ${plan.summary}`
        : ` #${issue.number} is assigned to ${issue.assigneeName}.`;
  return flashTo(ctx, repoBase(repo), { message: `${first}${second}` });
}

// ---- the repo home's strip ----

/**
 * One line under the repo header, for a repository that runs: production's
 * state, the commit it serves, its URL, how many previews are up, and the
 * way to the App page. Nothing for a repository that is not an app.
 */
export function appStrip(ctx: Ctx, repo: Repo): Html {
  const view = appView(ctx.app, ctx.auth.user, repo);
  if (!view.ok) return html``;
  const { app: record, environments, serving } = view.value;
  const base = repoBase(repo);
  const production = environments.find((env) => env.env === "production");
  const previews = environments.length - (production === undefined ? 0 : 1);
  const url = appsRuntime(ctx.app)?.urlFor(record, "production");
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
          class="app-url"
          href="${base}/app/production/open"
          title="Open ${u}"
          >${u}</a
        >`,
    )}
    ${when(
      previews > 0,
      () =>
        html`<span class="muted"
          >${previews} preview${previews === 1 ? "" : "s"}</span
        >`,
    )}
    <span class="spacer"></span>
    ${btn("App", {
      href: `${base}/app`,
      size: "sm",
      variant: "ghost",
      icon: "chevronRight",
    })}
  </div>`;
}

// ---- the app page ----

/** One environment: what it is doing, the facts, and the buttons. */
function envCard(base: string, env: EnvStatus, writer: boolean): Html {
  const number = envPull(env.env);
  return card(
    envFacts(base, env, { url: true }),
    {
      extra: "env-card",
      ...(env.state === "failed" || env.error !== undefined
        ? { tone: "danger" as const }
        : {}),
      head: html`${icon(number === undefined ? "rocket" : "pull")}
        <h2>
          ${number === undefined
            ? "production"
            : html`preview of <a href="${base}/pulls/${number}">#${number}</a>`}
        </h2>
        ${envStateBadge(env.state)}`,
      foot: html`${btn("Open", {
        href: `${base}/app/${env.env}/open`,
        size: "sm",
        variant: "outline",
        icon: "external",
      })}
      ${envActions(base, env, writer)}`,
    },
  );
}

// GET /:owner/:name/app
export function appPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const view = appView(ctx.app, ctx.auth.user, repo);
  if (!view.ok) return notFoundPage(ctx);
  const { app: record, environments, serving } = view.value;
  const base = repoBase(repo);
  const writer = canWrite(ctx.app.db, repo, ctx.auth.user);
  const admin = canAdmin(ctx.app.db, repo, ctx.auth.user);
  // Production first, then previews by pull number: the runtime's own order.
  const envs = environments;
  const listed = listRepoRuns(ctx.app, ctx.auth.user, repo, { limit: 15 });
  const runs = listed.ok ? listed.value : [];
  const crew = listCrew(ctx.app, ctx.auth.user, repo);
  const url = appsRuntime(ctx.app)?.urlFor(record, "production");
  const production = envs.find((env) => env.env === "production");
  const ssh = writer
    ? terminalFor(ctx.app, record, "production", production)
    : undefined;
  // The same rows the runs page draws, from the same two grouped reads: a
  // table's first column folds into a sliver at phone width, a row does not.
  const runsHead = html`${icon("activity")}
    <h2>Recent runs</h2>
    <span class="spacer"></span>
    ${btn("All runs", {
      href: `${base}/runs`,
      size: "sm",
      variant: "ghost",
      icon: "chevronRight",
    })}`;
  const actors = actorsFor(ctx, runs);
  const issues = issuesFor(ctx, runs);
  const runsCard =
    runs.length === 0
      ? card(html`<p class="muted small">No runs yet.</p>`, { head: runsHead })
      : listCard(
          runs.map((run) => runRow(base, run, actors, issues)),
          { head: runsHead },
        );
  // Something still moving is news the live pill announces; the page is
  // never pulled out from under a reader.
  const moving =
    envs.some((env) => env.state === "deploying") ||
    runs.some((run) => !isTerminal(run.state));

  const environmentsBlock = !serving
    ? card(
        html`<p class="muted small">
          Nothing is serving apps on this forge right now — it was started with
          <span class="mono">FORGE_APPS=0</span>. The app is still declared;
          start the forge with apps on and production comes up from the default
          branch.
        </p>`,
        {
          head: html`${icon("alert")}
            <h2>Not serving</h2>`,
        },
      )
    : envs.length === 0
      ? empty({
          icon: "rocket",
          title: "Nothing is running yet",
          note: "Production starts from the default branch; a preview starts when a pull request opens. Give it a moment, or push something.",
        })
      : html`<div class="stack">
          ${envs.map((env) => envCard(base, env, writer))}
        </div>`;

  const about = card(
    html`<dl>
      <dt>Hostname</dt>
      <dd>
        ${url === undefined
          ? html`<span class="muted">not serving</span>`
          : html`<a href="${base}/app/production/open" class="mono">${url}</a>`}
      </dd>
      ${when(
        writer,
        () =>
          html`<dt>Terminal</dt>
            <dd>${terminalLine(ssh, ctx.app.config.sshHostKey)}</dd>`,
      )}
      <dt>Access</dt>
      <dd>
        ${record.access === "private"
          ? "private — only people who can see this repository"
          : "public — anyone with the link"}
      </dd>
      <dt>Preview data</dt>
      <dd>
        ${record.previewData === "copy"
          ? "a copy of production's, taken when the preview starts"
          : "empty"}
      </dd>
    </dl>`,
    {
      extra: "about",
      head: html`${icon("rocket")}
        <h2>${record.slug}</h2>
        ${when(
          admin,
          () =>
            html`<span class="spacer"></span> ${btn("Settings", {
                href: `${base}/settings/app`,
                size: "sm",
                variant: "ghost",
                icon: "settings",
              })}`,
        )}`,
    },
  );

  const crewCard = when(
    crew.ok && crew.value.length > 0,
    () =>
      html`<div class="mt">
        ${listCard(
          (crew.ok ? crew.value : []).map((agent) =>
            row({
              lead: icon("bot"),
              title: html`${userLink(agent.user.username)}`,
              ...(agent.model === "" ? {} : { meta: html`${agent.model}` }),
            }),
          ),
          {
            head: html`${icon("bot")}
              <h2>Crew</h2>`,
          },
        )}
      </div>`,
  );

  const body = html`${repoHeader(ctx, repo, "app", { compact: true })}
    <div class="split">
      <div>
        ${environmentsBlock}
        <div class="mt">${runsCard}</div>
      </div>
      <aside>${about} ${crewCard}</aside>
    </div>
    ${when(moving, () => liveMount({ repo: base }))}`;

  return page({
    ctx,
    title: `App · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    scriptJs: liveClientJs,
  });
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
    ${env === undefined ? null : envStateBadge(env.state)}`;
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
  return card(
    html`${envFacts(base, env)}
      ${when(writer, () =>
        terminalLine(
          terminalFor(ctx.app, view.value.app, env.env, env),
          ctx.app.config.sshHostKey,
        ),
      )}
      <div class="bar mt">
        ${btn("Open preview", {
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
  const runtime = appsRuntime(ctx.app);
  const host = (ctx.url.searchParams.get("host") ?? "").trim();
  const wanted = ctx.url.searchParams.get("to") ?? "/";
  const path =
    wanted.startsWith("/") && !wanted.startsWith("//") ? wanted : "/";
  if (runtime === undefined || host === "") return notFoundPage(ctx);
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
  const link = openEnvUrl(ctx.app, ctx.auth.user, repo, ctx.params.env ?? "");
  if (!link.ok) {
    if (link.error === "unauthorized") return signInFirst(ctx);
    if (link.error === "no_runtime")
      return flashTo(ctx, `${repoBase(repo)}/app`, {
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

function envFailure(ctx: Ctx, repo: Repo, error: string): Response {
  if (error === "not_found" || error === "no_such_env")
    return notFoundPage(ctx);
  const words: Record<string, string> = {
    forbidden: "You need write access to do that.",
    no_runtime: "Nothing is serving apps on this forge.",
    nothing_to_deploy:
      "There is nothing to deploy: the branch has no commits, or the pull request is closed.",
  };
  return flashTo(ctx, `${repoBase(repo)}/app`, {
    tone: "danger",
    message: words[error] ?? "That could not be done.",
  });
}

// POST /:owner/:name/app/:env/redeploy
export async function appRedeploy(ctx: Ctx): Promise<Response> {
  const gate = await envForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, env, user } = gate;
  const queued = await redeployEnv(ctx.app, user, repo, env);
  if (!queued.ok) return envFailure(ctx, repo, queued.error);
  const base = repoBase(repo);
  const run = queued.value;
  return redirect(
    run === undefined ? `${base}/app` : `${base}/runs/${run.id}`,
    {
      url: ctx.url,
      flash: {
        message:
          run === undefined
            ? `${envLabel(env as EnvName)} already serves that commit.`
            : `Redeploying ${envLabel(env as EnvName)}.`,
      },
    },
  );
}

// POST /:owner/:name/app/:env/stop
export async function appStop(ctx: Ctx): Promise<Response> {
  const gate = await envForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, env, user } = gate;
  const stopped = await stopEnv(ctx.app, user, repo, env);
  if (!stopped.ok) return envFailure(ctx, repo, stopped.error);
  return flashTo(ctx, `${repoBase(repo)}/app`, {
    message: `Stopped ${envLabel(env as EnvName)}. Its data is kept; Redeploy brings it back.`,
  });
}
