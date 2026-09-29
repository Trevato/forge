/**
 * Repository settings, admin-only: what the repo is (description, visibility,
 * default branch, protection), the labels that organise its work, the
 * webhooks that carry its events out, and the one door marked danger.
 *
 * Four pages rather than one long scroll, because a settings page you have to
 * hunt through is a settings page people get wrong. Every mutation is its own
 * same-origin POST and every one of them says what happened.
 */

import {
  deleteAppEnvVar,
  disableApp,
  enableApp,
  setAppEnvVar,
  updateAppSettings,
} from "../../actions/apps.ts";
import {
  addAppDomain,
  checkAppDomain,
  listAppDomains,
  removeAppDomain,
  type AppDomainView,
} from "../../actions/domains.ts";
import {
  addPromptSource,
  listPromptSources,
  removePromptSource,
  runPromptSource,
  type PromptSourceView,
} from "../../actions/prompts.ts";
import type { DnsRecord } from "../../apps/domains.ts";
import { REFRESH_AFTER_DAYS } from "../../crew/prompts.ts";
import {
  listAppEnvNames,
  NAME_MAX,
  type AppEnvName,
  type AppEnvScope,
} from "../../core/app_env.ts";
import {
  addToCrew,
  listAllAgents,
  listCrew,
  removeFromCrew,
} from "../../actions/crew.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import {
  CREW_ROLES,
  getAgentByName,
  isCrewRole,
  listCrewRoles,
  setCrewRole,
} from "../../core/agents.ts";
import { isAutonomy } from "../../core/repos.ts";
import {
  createLabel,
  createWebhook,
  deleteLabel,
  deleteRepo,
  deleteWebhook,
  updateLabel,
  updateRepoSettings,
} from "../../actions/repos.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import type { PreviewData } from "../../apps/data.ts";
import {
  getAppByRepo,
  SLUG_MAX,
  slugFor,
  type AppAccess,
  type AppRecord,
} from "../../core/apps.ts";
import { listLabels, type Label } from "../../core/issues.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { listWebhooks, recentDeliveries } from "../../core/webhooks.ts";
import { listRefs } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  repoBase,
  repoHeader,
  repoNotFound,
  repoPalette,
  settingsLayout,
} from "../chrome.ts";
import { studioCrewSettings } from "../studio/crew.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo, page } from "../layout.ts";
import type { Flash } from "../flash.ts";
import {
  badge,
  btn,
  card,
  confirmAction,
  dot,
  empty,
  field as formField,
  labelChip,
  labelCss,
  listCard,
  row,
  selectField,
  time,
  timeAgo,
  userLink,
} from "../ui.ts";
import { crewReadiness } from "./crew.ts";
import { grantsSection, saveGrants } from "./subscriptions.ts";

type Section =
  | "general"
  | "app"
  | "crew"
  | "prompts"
  | "autonomy"
  | "labels"
  | "hooks"
  | "danger";

/** The repo, but only for someone who administers it. A non-admin is told
 * nothing — the settings tab is not even rendered for them. */
function loadAdminRepo(ctx: Ctx): Repo | undefined {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return undefined;
  return repo;
}

function sections(base: string, active: Section) {
  return [
    {
      label: "General",
      href: `${base}/settings`,
      icon: "settings" as const,
      current: active === "general",
    },
    {
      label: "App",
      href: `${base}/settings/app`,
      icon: "rocket" as const,
      current: active === "app",
    },
    {
      label: "Crew",
      href: `${base}/settings/crew`,
      icon: "bot" as const,
      current: active === "crew",
    },
    {
      label: "Prompts",
      href: `${base}/settings/prompts`,
      icon: "comment" as const,
      current: active === "prompts",
    },
    {
      label: "Autonomy",
      href: `${base}/settings/autonomy`,
      icon: "play" as const,
      current: active === "autonomy",
    },
    {
      label: "Labels",
      href: `${base}/settings/labels`,
      icon: "tag" as const,
      current: active === "labels",
    },
    {
      label: "Webhooks",
      href: `${base}/settings/hooks`,
      icon: "webhook" as const,
      current: active === "hooks",
    },
    {
      label: "Danger zone",
      href: `${base}/settings/danger`,
      icon: "alert" as const,
      current: active === "danger",
    },
  ];
}

/** Every settings page is the same frame with a different pane inside it. */
function settingsPageResponse(
  ctx: Ctx,
  repo: Repo,
  active: Section,
  title: string,
  body: Html,
  styleCss?: string,
  status = 200,
): Response {
  return page(
    {
      ctx,
      title: `${title} · ${repo.name}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      ...(styleCss !== undefined ? { styleCss } : {}),
      body: html`${repoHeader(ctx, repo, "settings", { compact: true })}
      ${settingsLayout(sections(repoBase(repo), active), body)}`,
    },
    status,
  );
}

/** The gate every settings POST passes: admin, same-origin, admin scope. */
async function adminForm(
  ctx: Ctx,
): Promise<{ repo: Repo; form: Form } | Response> {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return { repo, form };
}

// ---- general ----

export async function settingsPage(ctx: Ctx): Promise<Response> {
  // In the studio, the app's head leads to one page for the crew and the
  // ceiling — the two decisions that are the studio's own story — rather
  // than dev's full settings shell. `?mode=dev` is the way to the rest.
  const studio =
    ctx.mode === "studio" && ctx.url.searchParams.get("mode") !== "dev";
  if (studio) {
    const readable = loadRepo(ctx);
    if (!readable) return repoNotFound(ctx);
    const record = getAppByRepo(ctx.app.db, readable.id);
    if (record !== undefined) return studioCrewSettings(ctx, readable, record);
  }
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const refs = await listRefs(dir, "refs/heads/");
  const branches = refs.ok
    ? refs.value.map((r) => r.name.replace("refs/heads/", "")).sort()
    : [];
  if (!branches.includes(repo.defaultBranch))
    branches.unshift(repo.defaultBranch);

  const body = card(
    html`<form method="post" action="${base}/settings">
      ${formField({
        label: "Description",
        name: "description",
        value: repo.description,
        hint: "One line, shown wherever this repository is listed.",
      })}
      ${selectField({
        label: "Visibility",
        name: "visibility",
        hint: "A private repository and a repository that does not exist look identical to anyone else.",
        options: [
          {
            value: "private",
            label: "Private",
            selected: repo.visibility === "private",
          },
          {
            value: "public",
            label: "Public",
            selected: repo.visibility === "public",
          },
        ],
      })}
      ${selectField({
        label: "Default branch",
        name: "defaultBranch",
        hint: "Where the repository opens, and what a bare clone checks out.",
        options: branches.map((b) => ({
          value: b,
          label: b,
          selected: b === repo.defaultBranch,
        })),
      })}
      <div class="field">
        <label class="check">
          <input
            type="checkbox"
            name="protect"
            ${repo.protectDefault ? html`checked` : null}
          />
          <span
            >Protect the default branch — no force-push, no deletion. Enforced
            by the pre-receive hook, so it holds for every client.</span
          >
        </label>
      </div>
      <div class="field">
        <label class="check">
          <input
            type="checkbox"
            name="requireReview"
            ${repo.requireReview ? html`checked` : null}
          />
          <span
            >Require an approving review before merging — of the commit that is
            head <em>now</em>, so a push after an approval dismisses it. Refused
            in the merge itself, not just hidden on the button.</span
          >
        </label>
      </div>
      <div class="field">
        <label class="check">
          <input
            type="checkbox"
            name="requireChecks"
            ${repo.requireChecks ? html`checked` : null}
          />
          <span
            >Require a passing deploy before merging — the check is the pull
            request's preview coming up at the commit that is head <em>now</em>.
            Read live inside the merge, like the review.</span
          >
        </label>
      </div>
      <div class="form-actions">
        ${btn("Save changes", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h2>General</h2>` },
  );
  return settingsPageResponse(ctx, repo, "general", "Settings", body);
}

export async function settingsUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const branch = field(form, "defaultBranch");

  const updated = await updateRepoSettings(ctx.app, ctx.auth.user, repo, {
    description: field(form, "description"),
    visibility: field(form, "visibility") === "public" ? "public" : "private",
    protectDefault: form.get("protect") !== null,
    requireReview: form.get("requireReview") !== null,
    requireChecks: form.get("requireChecks") !== null,
    ...(branch !== "" ? { defaultBranch: branch } : {}),
  });
  const flash: Flash = updated.ok
    ? { message: "Settings saved." }
    : {
        tone: "danger",
        message:
          updated.error === "unknown_branch"
            ? "That branch does not exist in this repository."
            : "Those settings could not be saved.",
      };
  return flashTo(ctx, `${base}/settings`, flash);
}

// ---- app ----

interface AppValues {
  slug: string;
  access: AppAccess;
  previewData: PreviewData;
}

const APP_ERRORS: Record<string, string> = {
  invalid_slug: `Lowercase letters and digits, single hyphens inside, at most ${SLUG_MAX} characters.`,
  slug_taken: "Another app already answers to that hostname.",
  already_app: "This repository is already an app.",
};

/**
 * The one form, for both moments: turning a repository into an app and
 * changing how it is served. Which verb the button wears is the only
 * difference, because `enableApp` and `updateAppSettings` take the same
 * three facts.
 */
function appSettingsView(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord | undefined,
  values: AppValues,
  error?: string,
): Html {
  const base = repoBase(repo);
  const runtime = appsRuntime(ctx.app);
  const domain = runtime?.options.domain;
  const form = card(
    html`${when(
        record === undefined,
        () =>
          html`<p class="muted small mb">
            A repository that runs. Production follows
            <span class="mono">${repo.defaultBranch}</span>; every open pull
            request gets a preview with its own copy of the data. The repository
            says how to run itself in <span class="mono">forge.json</span>, or
            with a <span class="mono">start</span> script.
          </p>`,
      )}
      <form method="post" action="${base}/settings/app">
        ${formField({
          label: "Slug",
          name: "slug",
          value: values.slug,
          mono: true,
          required: true,
          pattern: "[a-z0-9](-?[a-z0-9])*",
          hint:
            domain === undefined
              ? "The label its hostnames are built from."
              : `Its hostnames: ${values.slug || "<slug>"}.${domain} and ${values.slug || "<slug>"}--<n>.${domain} for the preview of pull #n.`,
          ...(error ? { error } : {}),
        })}
        ${selectField({
          label: "Access",
          name: "access",
          hint:
            values.access === "public"
              ? `Right now anyone with the link can open it, signed in or not. The code stays as ${repo.visibility} as the repository is: the two are set separately.`
              : `Right now a visitor is asked to sign in and let through only if they can see this repository${repo.visibility === "private" ? " — its collaborators, since the repository is private" : " — anyone signed in, since the repository is public"}. Everyone else sees not found. Choose Public to share it with people who cannot see the code.`,
          options: [
            {
              value: "private",
              label: "Private — people who can see this repository",
              selected: values.access === "private",
            },
            {
              value: "public",
              label: "Public — anyone with the link",
              selected: values.access === "public",
            },
          ],
        })}
        ${selectField({
          label: "Preview data",
          name: "previewData",
          hint: "What a new preview's data directory starts as. A copy is never a window: nothing a preview writes reaches production.",
          options: [
            {
              value: "copy",
              label: "A copy of production's, taken when the preview starts",
              selected: values.previewData === "copy",
            },
            {
              value: "empty",
              label: "Empty",
              selected: values.previewData === "empty",
            },
          ],
        })}
        <div class="form-actions">
          ${btn(record === undefined ? "Run as an app" : "Save changes", {
            variant: "primary",
            ...(record === undefined ? { icon: "rocket" as const } : {}),
          })}
          ${when(record !== undefined, () =>
            btn("Environments", {
              href: `${base}/app`,
              variant: "ghost",
              icon: "rocket",
            }),
          )}
        </div>
      </form>`,
    {
      head: html`${icon("rocket")}
        <h2>${record === undefined ? "Run as an app" : "App"}</h2>`,
    },
  );
  if (record === undefined) return form;
  const domains = listAppDomains(ctx.app, ctx.auth.user, repo);
  return html`${form}
    <div class="mt">
      ${appEnvView(base, listAppEnvNames(ctx.app.db, record.id))}
    </div>
    <div class="mt">
      ${appDomainsView(base, domains.ok ? domains.value : undefined)}
    </div>
    <div class="mt">
      ${card(
        html`<p>
            Production and every preview stop, and their data directories and
            checkouts are removed. The repository and its code are untouched.
          </p>
          <div class="form-actions">
            ${confirmAction({
              action: `${base}/settings/app/disable`,
              verb: "Stop running as an app",
            })}
          </div>`,
        {
          tone: "danger",
          head: html`${icon("alert")}
            <h2>Stop running as an app</h2>`,
        },
      )}
    </div>`;
}

/**
 * The app's environment: the names that are set, and a form for one more.
 * Values are write-only — the page shows a name and when it was set, and
 * the value input forgets what was typed the moment the form is sent.
 */
const SCOPE_WORDS: Record<AppEnvScope, string> = {
  all: "everywhere",
  production: "production",
  preview: "previews",
};

function appEnvView(base: string, names: AppEnvName[]): Html {
  const rows = names.map((v) =>
    row({
      lead: icon("key"),
      title: html`<span class="mono">${v.name}</span>`,
      meta: html`${SCOPE_WORDS[v.scope]} · set ${time(v.updatedAt)}`,
      trail: html`<form
        class="row-actions"
        method="post"
        action="${base}/settings/app/env/${encodeURIComponent(v.name)}/delete"
      >
        <input type="hidden" name="scope" value="${v.scope}" />
        ${btn("Remove", {
          size: "sm",
          icon: "x",
          label: `Remove ${v.name} (${SCOPE_WORDS[v.scope]})`,
        })}
      </form>`,
    }),
  );
  return card(
    html`<div class="card-body">
        <p class="muted small">
          What the app reads from its environment at start-up — an admin
          password, an API key. Values are write-only: set one, and it is never
          shown again. A variable goes everywhere, to production only, or to
          previews only; the same name may be set in each, and the narrower one
          wins — a test key for previews, the live one for production. Changing
          one redeploys what reads it, and nothing else.
        </p>
      </div>
      ${when(
        rows.length > 0,
        () =>
          html`<ul class="list">
            ${rows}
          </ul>`,
      )}
      <form class="edit-row" method="post" action="${base}/settings/app/env">
        <input
          class="input mono"
          type="text"
          name="name"
          placeholder="NAME"
          aria-label="Variable name"
          pattern="[A-Z][A-Z0-9_]*"
          maxlength="${String(NAME_MAX)}"
          autocomplete="off"
          spellcheck="false"
          required
        />
        <input
          class="input"
          type="password"
          name="value"
          placeholder="Value"
          aria-label="Value"
          autocomplete="off"
          required
        />
        <select class="input" name="scope" aria-label="Where it applies">
          <option value="all">Everywhere</option>
          <option value="production">Production only</option>
          <option value="preview">Previews only</option>
        </select>
        ${btn("Set", { variant: "primary", size: "sm", icon: "plus" })}
      </form>`,
    {
      head: html`${icon("key")}
        <h2>Environment</h2>`,
      pad: false,
    },
  );
}

/**
 * The app's own domains: each with what the last check said, the records
 * to publish while it waits, and a form for one more. The forge serves a
 * domain the moment it is verified; the app itself hears its new address
 * at its next deploy, because a process reads its URL once, at start.
 * `undefined` is a forge where nothing serves apps: a domain would have
 * nowhere to point, so the card says so and offers no form.
 */
function appDomainsView(
  base: string,
  domains: AppDomainView[] | undefined,
): Html {
  const at = (host: string) =>
    `${base}/settings/app/domains/${encodeURIComponent(host)}`;
  const rows = (domains ?? []).map(
    (d) =>
      html`<li>
        <div class="row">
          <span class="row-lead">${icon("globe")}</span>
          <span class="row-main">
            <span class="row-title"
              ><span class="mono">${d.host}</span> ${d.verified
                ? badge("live", { tone: "success" })
                : badge("waiting for DNS", { tone: "attn" })}</span
            >
            <span class="row-meta" title="${d.said}"
              >${d.said === "" ? "Not checked yet." : d.said}
              ${d.checkedAt === null
                ? null
                : html` · checked ${time(d.checkedAt)}`}</span
            >
            ${when(!d.verified, () => recordsToPublish(d.records))}
          </span>
          <span class="row-trail">
            <form method="post" action="${at(d.host)}/check">
              ${btn("Check now", { size: "sm", icon: "globe" })}
            </form>
            ${confirmAction({
              action: `${at(d.host)}/delete`,
              verb: "Remove",
              size: "sm",
            })}
          </span>
        </div>
      </li>`,
  );
  return card(
    html`<div class="card-body">
        <p class="muted small">
          Serve the app at a name of your own —
          <span class="mono">app.example.com</span>, or an apex. Add it, publish
          the two records it shows, and press Check now.
        </p>
      </div>
      ${when(
        rows.length > 0,
        () =>
          html`<ul class="list">
            ${rows}
          </ul>`,
      )}
      ${domains === undefined
        ? html`<div class="card-body">
            <p class="muted small">
              Nothing is serving apps on this forge, so a domain would have
              nowhere to point.
            </p>
          </div>`
        : html`<div class="card-body">
              <p class="muted small">
                The forge serves the app there as soon as the record is
                verified. The app itself learns its new address at its next
                deploy.
              </p>
            </div>
            <form
              class="edit-row"
              method="post"
              action="${base}/settings/app/domains"
            >
              <input
                class="input mono"
                type="text"
                name="host"
                placeholder="app.example.com"
                aria-label="Domain"
                autocomplete="off"
                spellcheck="false"
                required
              />
              ${btn("Add", { variant: "primary", size: "sm", icon: "plus" })}
            </form>`}`,
    {
      head: html`${icon("globe")}
        <h2>Domains</h2>`,
      pad: false,
    },
  );
}

/** The records as a person copies them into a zone: type, name, value. */
function recordsToPublish(records: DnsRecord[]): Html {
  const width = Math.max(...records.map((r) => r.name.length)) + 2;
  const lines = records
    .map((r) => `${r.type.padEnd(6)} ${r.name.padEnd(width)} ${r.value}`)
    .join("\n");
  const notes = records.filter((r) => r.note !== undefined);
  return html`<pre class="domain-records">${lines}</pre>
    ${notes.map((r) => html`<span class="row-meta">${r.note}</span>`)}`;
}

const appValues = (repo: Repo, record: AppRecord | undefined): AppValues => ({
  slug: record?.slug ?? slugFor(repo.name),
  access: record?.access ?? repo.visibility,
  previewData: record?.previewData ?? "copy",
});

// GET /:owner/:name/settings/app
export function appSettingsPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const record = getAppByRepo(ctx.app.db, repo.id);
  return settingsPageResponse(
    ctx,
    repo,
    "app",
    "App",
    appSettingsView(ctx, repo, record, appValues(repo, record)),
  );
}

// POST /:owner/:name/settings/app — enable, or change.
export async function appSettingsUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const record = getAppByRepo(ctx.app.db, repo.id);
  const values: AppValues = {
    slug: field(form, "slug").trim(),
    access: field(form, "access") === "public" ? "public" : "private",
    previewData: field(form, "previewData") === "empty" ? "empty" : "copy",
  };
  const saved =
    record === undefined
      ? enableApp(ctx.app, ctx.auth.user, repo, values)
      : updateAppSettings(ctx.app, ctx.auth.user, repo, values);
  if (!saved.ok) {
    if (saved.error === "not_found") return repoNotFound(ctx);
    return settingsPageResponse(
      ctx,
      repo,
      "app",
      "App",
      appSettingsView(
        ctx,
        repo,
        record,
        values,
        APP_ERRORS[saved.error] ?? "Those settings could not be saved.",
      ),
      undefined,
      422,
    );
  }
  const url = appsRuntime(ctx.app)?.urlFor(saved.value, "production");
  return flashTo(
    ctx,
    record === undefined
      ? `${repoBase(repo)}/app`
      : `${repoBase(repo)}/settings/app`,
    {
      message:
        record !== undefined
          ? "App settings saved."
          : url === undefined
            ? `${repo.name} is an app, but nothing is serving apps on this forge.`
            : `${repo.name} is starting at ${url}.`,
    },
  );
}

// POST /:owner/:name/settings/app/disable
export async function appDisable(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const disabled = disableApp(ctx.app, ctx.auth.user, repo);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    disabled.ok
      ? {
          message: `${repo.name} no longer runs as an app. Its code is untouched.`,
        }
      : { tone: "danger", message: "This repository is not an app." },
  );
}

const APP_ENV_ERRORS: Record<string, string> = {
  invalid_name: `A name is capital letters, digits and underscores, starting with a letter — ADMIN_PASSWORD, STRIPE_SECRET_KEY — and at most ${NAME_MAX} characters.`,
  reserved_name:
    "That name is the forge's own (PORT, HOST, PATH, FORGE_…); the app is already told it.",
  invalid_value: "A value is one line or many, never empty and under 64 KiB.",
  invalid_scope: "A variable goes everywhere, to production, or to previews.",
};

// POST /:owner/:name/settings/app/env — set one variable.
export async function appEnvSet(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const name = field(form, "name").trim();
  const set = await setAppEnvVar(
    ctx.app,
    ctx.auth.user,
    repo,
    name,
    field(form, "value"),
    field(form, "scope") || "all",
  );
  if (!set.ok && set.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    set.ok
      ? {
          message: `${set.value.name} is set ${set.value.scope === "all" ? "everywhere" : `for ${SCOPE_WORDS[set.value.scope]}`}.${redeploying(ctx, "with it")}`,
        }
      : {
          tone: "danger",
          message:
            APP_ENV_ERRORS[set.error] ?? "That variable could not be set.",
        },
  );
}

// POST /:owner/:name/settings/app/env/:var/delete — `:var`, because
// `:name` is the repository's.
export async function appEnvDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const name = ctx.params.var ?? "";
  const removed = await deleteAppEnvVar(
    ctx.app,
    ctx.auth.user,
    repo,
    name,
    field(form, "scope") || "all",
  );
  if (!removed.ok && removed.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    removed.ok
      ? { message: `${name} is removed.${redeploying(ctx, "without it")}` }
      : { tone: "danger", message: "No variable by that name." },
  );
}

const APP_DOMAIN_ERRORS: Record<string, string> = {
  invalid_host:
    "A domain is a hostname: letters, digits and hyphens in at least two labels, like app.example.com.",
  reserved_host: "That name is the forge's own to hand out.",
  taken: "Another app already answers to that domain.",
  no_runtime: "Nothing is serving apps on this forge.",
};

/** What the records say, as one flash: type, name and value, in words. */
function recordsInWords(records: DnsRecord[]): string {
  return records
    .map((r) =>
      r.type === "TXT"
        ? `a TXT record at ${r.name} with the value ${r.value}`
        : r.type === "CNAME"
          ? `a CNAME from ${r.name} to ${r.value}`
          : `an ALIAS from ${r.name} to ${r.value}`,
    )
    .join(" and ");
}

// POST /:owner/:name/settings/app/domains — add one.
export async function appDomainAdd(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const added = addAppDomain(ctx.app, ctx.auth.user, repo, field(form, "host"));
  if (!added.ok && added.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    added.ok
      ? {
          message: `${added.value.host} is added. Publish ${recordsInWords(added.value.records)}, then press Check now.`,
        }
      : {
          tone: "danger",
          message:
            APP_DOMAIN_ERRORS[added.error] ?? "That domain could not be added.",
        },
  );
}

// POST /:owner/:name/settings/app/domains/:host/check — look the proof up.
export async function appDomainCheck(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const checked = await checkAppDomain(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.host ?? "",
  );
  if (!checked.ok && checked.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    checked.ok
      ? {
          ...(checked.value.verified ? {} : { tone: "attn" as const }),
          message: checked.value.said,
        }
      : {
          tone: "danger",
          message:
            APP_DOMAIN_ERRORS[checked.error] ?? "No domain by that name.",
        },
  );
}

// POST /:owner/:name/settings/app/domains/:host/delete
export async function appDomainDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const host = ctx.params.host ?? "";
  const removed = removeAppDomain(ctx.app, ctx.auth.user, repo, host);
  if (!removed.ok && removed.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    removed.ok
      ? { message: `${host} is removed. The forge no longer answers there.` }
      : { tone: "danger", message: "No domain by that name." },
  );
}

/** What a change to the environment sets in motion — when anything serves. */
function redeploying(ctx: Ctx, how: string): string {
  return appsRuntime(ctx.app) === undefined
    ? ""
    : ` Production and every preview are starting again ${how}.`;
}

// ---- prompts ----

const PROMPT_ERRORS: Record<string, string> = {
  invalid_at: "The time is hours and minutes in UTC, like 15:00.",
  invalid_token:
    "Paste the long-lived token as Instagram gave it: one line, no spaces.",
  invalid_kind: "Only Instagram is known here.",
  already_connected:
    "An Instagram account is already connected here. Remove it first.",
  no_such_source: "No account by that id.",
  not_running: "The prompt routine is not running on this forge.",
};

/** The day the forge will refresh a token pasted or refreshed at `iso`. */
function refreshDay(iso: string): string {
  return new Date(Date.parse(iso) + REFRESH_AFTER_DAYS * 24 * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The Instagram card: the account and what the last run said when one is
 * connected, the form when none is. Beneath it, the one-time steps at Meta,
 * because the forge cannot take them for anyone. The token is a password
 * field on the way in and nowhere on the way out.
 */
function promptsView(base: string, sources: PromptSourceView[]): Html {
  const source = sources.find((s) => s.kind === "instagram");
  const at = (id: string) =>
    `${base}/settings/prompts/${encodeURIComponent(id)}`;
  const body =
    source === undefined
      ? html`<div class="card-body">
            <p class="muted small">
              Once a day, the top comment on your latest Reel becomes the crew's
              next tell.
            </p>
          </div>
          <form
            class="card-body"
            method="post"
            action="${base}/settings/prompts"
          >
            ${formField({
              label: "Token",
              name: "token",
              type: "password",
              hint: "A long-lived Instagram token. The forge seals it, refreshes it before it expires, and never shows it again.",
              required: true,
              autocomplete: "off",
              mono: true,
            })}
            ${formField({
              label: "Every day at … UTC",
              name: "at",
              type: "time",
              value: "15:00",
              required: true,
            })}
            <div class="form-actions">
              ${btn("Add", { variant: "primary", icon: "plus" })}
            </div>
          </form>`
      : html`<ul class="list">
          <li>
            <div class="row">
              <span class="row-lead">${icon("comment")}</span>
              <span class="row-main">
                <span class="row-title"
                  >${source.account === ""
                    ? html`<span class="muted">not read yet</span>`
                    : `@${source.account}`}
                  ${badge(`every day at ${source.atUtc} UTC`)}</span
                >
                <span class="row-meta"
                  >${source.lastRanAt === null
                    ? "Has not run yet."
                    : html`Last ran ${time(source.lastRanAt)}.
                      ${source.lastSaid}`}</span
                >
                <span class="row-meta"
                  >Token refreshed ${timeAgo(source.tokenRefreshedAt)}; the
                  forge refreshes it again around
                  ${refreshDay(source.tokenRefreshedAt)}.</span
                >
              </span>
              <span class="row-trail">
                <form method="post" action="${at(source.id)}/run">
                  ${btn("Fetch now", { size: "sm", icon: "sync" })}
                </form>
                ${confirmAction({
                  action: `${at(source.id)}/delete`,
                  verb: "Remove",
                  size: "sm",
                })}
              </span>
            </div>
          </li>
        </ul>`;
  return html`${card(body, {
    head: html`${icon("comment")}
      <h2>Instagram</h2>`,
    pad: false,
  })}
  ${card(
    html`<p class="muted small">
        The one-time steps at Meta, for a professional account of your own. None
        of them needs App Review.
      </p>
      <ol class="steps">
        <li>
          Make the Instagram account a professional one — Business or Creator —
          in the Instagram app's settings.
        </li>
        <li>
          At developers.facebook.com, make a Meta app and add the Instagram
          product with <b>Business Login for Instagram</b>. No Facebook Page is
          needed.
        </li>
        <li>
          Get a token for the account with the scopes
          <span class="mono">instagram_business_basic</span> and
          <span class="mono">instagram_business_manage_comments</span>.
        </li>
        <li>
          Exchange it for a long-lived token, the one that lives sixty days; the
          product's docs show the one call.
        </li>
        <li>
          Paste the long-lived token above. The forge refreshes it before it
          expires, and the paste is never shown again.
        </li>
      </ol>`,
    { head: html`<h2>Getting a token</h2>` },
  )}`;
}

// GET /:owner/:name/settings/prompts
export function promptsSettingsPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const listed = listPromptSources(ctx.app, ctx.auth.user, repo);
  return settingsPageResponse(
    ctx,
    repo,
    "prompts",
    "Prompts",
    promptsView(repoBase(repo), listed.ok ? listed.value : []),
  );
}

// POST /:owner/:name/settings/prompts — connect an account.
export async function promptSourceAdd(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const added = addPromptSource(ctx.app, ctx.auth.user, repo, {
    kind: "instagram",
    token: field(form, "token"),
    at: field(form, "at"),
  });
  if (!added.ok && added.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/prompts`,
    added.ok
      ? {
          message: `Instagram is connected. Every day at ${added.value.atUtc} UTC the top comment on the latest Reel is told to the crew; press Fetch now to try it.`,
        }
      : {
          tone: "danger",
          message:
            PROMPT_ERRORS[added.error] ?? "The account could not be connected.",
        },
  );
}

// POST /:owner/:name/settings/prompts/:id/run — look at Instagram now.
export async function promptSourceRun(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const ran = await runPromptSource(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  if (!ran.ok && ran.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/prompts`,
    ran.ok
      ? {
          ...(ran.value.lastSaid.startsWith("Told the crew")
            ? {}
            : { tone: "attn" as const }),
          message: ran.value.lastSaid,
        }
      : {
          tone: "danger",
          message: PROMPT_ERRORS[ran.error] ?? "No account by that id.",
        },
  );
}

// POST /:owner/:name/settings/prompts/:id/delete
export async function promptSourceDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const removed = removePromptSource(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  if (!removed.ok && removed.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/prompts`,
    removed.ok
      ? { message: "Instagram is disconnected. The token is forgotten." }
      : { tone: "danger", message: "No account by that id." },
  );
}

// ---- crew ----

// GET /:owner/:name/settings/crew
export function crewSettingsPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const crewListed = listCrew(ctx.app, ctx.auth.user, repo);
  const crew = crewListed.ok ? crewListed.value : [];
  const allListed = listAllAgents(ctx.app, ctx.auth.user);
  const all = allListed.ok ? allListed.value : [];
  const onCrew = new Set(crew.map((agent) => agent.user.id));
  const roles = new Map(
    listCrewRoles(ctx.app.db, repo.id).map((c) => [c.agent.user.id, c.role]),
  );
  const available = all.filter((agent) => !onCrew.has(agent.user.id));
  const admin = ctx.auth.user?.isAdmin === true;

  const list =
    crew.length === 0
      ? empty({
          icon: "bot",
          title: "No crew yet",
          note: "An agent on the crew can read and write this repository, and starts working the moment an issue is assigned to it. It proposes through pull requests; a person merges.",
        })
      : listCard(
          crew.map((agent) =>
            row({
              lead: icon("bot"),
              title: html`${userLink(agent.user.username)}`,
              meta: html`<span title="${agent.brief}"
                >${agent.model === ""
                  ? "default model"
                  : agent.model}${agent.brief === ""
                  ? ""
                  : ` · ${agent.brief}`}</span
              >`,
              trail: html`<form
                  class="row-actions"
                  method="post"
                  action="${base}/settings/crew/${encodeURIComponent(
                    agent.user.username,
                  )}/role"
                >
                  <label class="sr-only" for="f-role-${agent.user.username}"
                    >Role of ${agent.user.username}</label
                  >
                  <select
                    class="input input-sm"
                    id="f-role-${agent.user.username}"
                    name="role"
                  >
                    ${CREW_ROLES.map(
                      (r) =>
                        html`<option
                          value="${r}"
                          ${(roles.get(agent.user.id) ?? "builder") === r
                            ? raw("selected")
                            : null}
                        >
                          ${r}
                        </option>`,
                    )}
                  </select>
                  ${btn("Set", { size: "sm" })}
                </form>
                <form
                  class="row-actions"
                  method="post"
                  action="${base}/settings/crew/${encodeURIComponent(
                    agent.user.username,
                  )}/remove"
                >
                  ${btn("Remove", { size: "sm", icon: "x" })}
                </form>`,
            }),
          ),
        );

  const add =
    available.length > 0
      ? card(
          html`<form
            class="edit-row"
            method="post"
            action="${base}/settings/crew"
          >
            <label class="sr-only" for="f-agent">Agent</label>
            <select class="input" id="f-agent" name="agent">
              ${available.map(
                (agent) =>
                  html`<option value="${agent.user.username}">
                    ${agent.user.username}${agent.model === ""
                      ? ""
                      : ` — ${agent.model}`}
                  </option>`,
              )}
            </select>
            ${btn("Add to crew", {
              variant: "primary",
              size: "sm",
              icon: "plus",
            })}
          </form>`,
          { head: html`<h2>Add an agent</h2>`, pad: false },
        )
      : card(
          all.length === 0
            ? html`<p class="muted small">
                No agents on this forge yet.
                ${admin
                  ? html`Create one under
                      <a href="/settings/crew">Settings → Crew</a>, then add it
                      here.`
                  : html`An admin can create one under account settings → Crew.`}
              </p>`
            : html`<p class="muted small">
                Every agent on this forge is already on this crew.
              </p>`,
          { head: html`<h2>Add an agent</h2>` },
        );

  // Whose money the crew spends here is the forge admin's to say.
  const grants = admin
    ? html`<div class="mt">
        ${grantsSection(ctx, {
          scopeId: repo.id,
          agents: crew,
          action: `${base}/settings/crew/subscriptions`,
          wider: "the owner's grant, or the forge's own token",
        })}
      </div>`
    : null;
  const body = html`${crewReadiness(ctx)} ${list}
    <div class="mt">${add}</div>
    ${grants}`;
  return settingsPageResponse(ctx, repo, "crew", "Crew", body);
}

// POST /:owner/:name/settings/crew/subscriptions
export async function crewSubscriptionsSave(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  if (ctx.auth.user?.isAdmin !== true) return repoNotFound(ctx);
  const crew = listCrew(ctx.app, ctx.auth.user, repo);
  saveGrants(ctx, form, repo.id, crew.ok ? crew.value : []);
  return flashTo(ctx, `${repoBase(repo)}/settings/crew`, {
    message: "Saved. The next run here works on what is ticked.",
  });
}

// POST /:owner/:name/settings/crew
export async function crewAdd(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const added = addToCrew(ctx.app, ctx.auth.user, repo, field(form, "agent"));
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/crew`,
    added.ok
      ? {
          message: `${added.value.user.username} is on the crew. Assign it an issue and it starts.`,
        }
      : { tone: "danger", message: "No such agent on this forge." },
  );
}

// POST /:owner/:name/settings/crew/:username/remove
export async function crewRemove(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const username = ctx.params.username ?? "";
  const removed = removeFromCrew(ctx.app, ctx.auth.user, repo, username);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/crew`,
    removed.ok
      ? { message: `${username} is off the crew.` }
      : { tone: "danger", message: "No such agent on this forge." },
  );
}

// ---- labels ----

/** `<input type="color">` submits `#rrggbb`; the store keeps six hex digits. */
function readColor(form: Form): string {
  return field(form, "color").replace(/^#/, "").toLowerCase();
}

/**
 * The colour control is a native `<input type="color">`, so it works with no
 * script at all — the hex beside it is a readout, updated live where there is
 * a script and correct on load where there is not. A browser submits it as
 * `#rrggbb`; `readColor` strips the hash on the way in.
 */
function colorField(value: string, label: string): Html {
  return html`<span class="color-field"
    ><input
      type="color"
      name="color"
      value="#${value}"
      aria-label="${label}"
    /><span class="hex">#${value}</span></span
  >`;
}

function labelEditor(base: string, label: Label): Html {
  return html`<li>
    <form
      class="edit-row"
      method="post"
      action="${base}/settings/labels/${label.id}"
    >
      <span class="preview">${labelChip(label)}</span>
      <input
        class="input"
        type="text"
        name="name"
        value="${label.name}"
        aria-label="Label name"
        required
      />
      ${colorField(label.color, `Colour of the label ${label.name}`)}
      ${btn("Save", { size: "sm" })}
      ${confirmAction({
        action: `${base}/settings/labels/${label.id}/delete`,
        verb: "Delete",
        size: "sm",
      })}
    </form>
  </li>`;
}

export function labelsPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const labels = listLabels(ctx.app.db, repo.id);

  const list =
    labels.length === 0
      ? empty({
          icon: "tag",
          title: "No labels yet",
          note: "Labels are this repository's work queue — a handful is usually enough.",
        })
      : html`<div class="card">
          <ul class="list">
            ${labels.map((l) => labelEditor(base, l))}
          </ul>
        </div>`;

  const create = card(
    html`<form class="edit-row" method="post" action="${base}/settings/labels">
      <input
        class="input"
        type="text"
        name="name"
        placeholder="Label name"
        aria-label="New label name"
        required
      />
      ${colorField("6b7280", "Colour of the new label")}
      ${btn("Add label", { variant: "primary", size: "sm" })}
    </form>`,
    { head: html`<h2>New label</h2>`, pad: false },
  );

  const body = html`${list}
    <div class="mt">${create}</div>`;
  return settingsPageResponse(
    ctx,
    repo,
    "labels",
    "Labels",
    body,
    labelCss(labels),
  );
}

export async function labelCreate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const created = createLabel(
    ctx.app,
    ctx.auth.user,
    repo,
    field(form, "name"),
    readColor(form) || "6b7280",
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/labels`,
    created.ok
      ? { message: `Label “${created.value.name}” created.` }
      : {
          tone: "danger",
          message:
            created.error === "taken"
              ? "This repository already has a label by that name."
              : "A label needs a name and a six-digit hex color.",
        },
  );
}

export async function labelUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const updated = updateLabel(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
    field(form, "name"),
    readColor(form),
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/labels`,
    updated.ok
      ? { message: `Label “${updated.value.name}” updated.` }
      : {
          tone: "danger",
          message:
            updated.error === "taken"
              ? "This repository already has a label by that name."
              : updated.error === "not_found"
                ? "That label no longer exists."
                : "A label needs a name and a six-digit hex color.",
        },
  );
}

export async function labelDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const removed = deleteLabel(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/labels`,
    removed.ok
      ? { message: "Label deleted." }
      : { tone: "danger", message: "That label no longer exists." },
  );
}

// ---- webhooks ----

export function hooksPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const hooks = listWebhooks(ctx.app.db, repo.id);

  const list =
    hooks.length === 0
      ? empty({
          icon: "webhook",
          title: "No webhooks yet",
          note: "Every event this repository produces can be POSTed to a URL you control, signed and retried.",
        })
      : html`${hooks.map((hook) => {
          const deliveries = recentDeliveries(ctx.app.db, hook.id, 10);
          return card(
            deliveries.length === 0
              ? html`<p class="muted small">No deliveries yet.</p>`
              : html`<div class="table-scroll">
                  <table class="table" data-dense>
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>State</th>
                        <th>Attempts</th>
                        <th>Last status</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${deliveries.map(
                        (d) =>
                          html`<tr>
                            <td class="mono">${d.kind}</td>
                            <td>
                              ${dot(
                                d.state === "ok"
                                  ? "success"
                                  : d.state === "failed"
                                    ? "danger"
                                    : "attn",
                              )}
                              ${d.state}
                            </td>
                            <td>${d.attempts}</td>
                            <td>${d.lastStatus ?? "—"}</td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>`,
            {
              pad: deliveries.length === 0,
              head: html`<span class="grow truncate mono" title="${hook.url}"
                  >${hook.url}</span
                >
                <span class="badge" data-variant="secondary"
                  >${hook.kinds}</span
                >
                <span class="badge"
                  >${dot(hook.active ? "success" : "attn")}${hook.active
                    ? "active"
                    : "paused"}</span
                >
                ${confirmAction({
                  action: `${base}/settings/hooks/${hook.id}/delete`,
                  verb: "Delete webhook",
                  size: "sm",
                })}`,
              foot: html`<span class="muted small"
                >Added
                ${time(hook.createdAt)}${when(
                  !hook.hasSecret,
                  () => html` · unsigned`,
                )}</span
              >`,
            },
          );
        })}`;

  const create = card(
    html`<form method="post" action="${base}/settings/hooks">
      ${formField({
        label: "Payload URL",
        name: "url",
        type: "url",
        required: true,
        placeholder: "https://example.com/hook",
        hint: "Every delivery is a POST with a JSON body.",
      })}
      ${formField({
        label: "Events",
        name: "kinds",
        value: "*",
        mono: true,
        hint: "A space-separated list of kinds; * means everything. e.g. push issue.* pull.merged",
      })}
      ${formField({
        label: "Signing secret",
        name: "secret",
        mono: true,
        hint: "Optional — one is generated for you. Deliveries carry HMAC-SHA256 in X-Forge-Signature-256.",
      })}
      <div class="form-actions">
        ${btn("Add webhook", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h2>New webhook</h2>` },
  );

  const body = html`${list}
    <div class="mt">${create}</div>`;
  return settingsPageResponse(ctx, repo, "hooks", "Webhooks", body);
}

export async function webhookCreate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const providedSecret = field(form, "secret");
  const created = createWebhook(ctx.app, ctx.auth.user, repo, {
    url: field(form, "url"),
    kinds: field(form, "kinds") || "*",
    ...(providedSecret !== "" ? { secret: providedSecret } : {}),
  });
  if (!created.ok) {
    return flashTo(ctx, `${repoBase(repo)}/settings/hooks`, {
      tone: "danger",
      message: "That URL is not one this forge will deliver to.",
    });
  }
  // The only moment the secret exists outside the database: show it once.
  return flashTo(ctx, `${repoBase(repo)}/settings/hooks`, {
    message:
      "Webhook created. Copy its signing secret now — it is never shown again.",
    code: created.value.secret,
  });
}

export async function webhookDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const removed = deleteWebhook(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/hooks`,
    removed.ok
      ? { message: "Webhook deleted." }
      : { tone: "danger", message: "That webhook no longer exists." },
  );
}

// ---- danger zone ----

export function dangerPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const full = `${repo.ownerName}/${repo.name}`;

  const body = card(
    html`<p>
        Deleting <strong>${full}</strong> removes its issues, pull requests,
        reviews, labels and webhooks, and erases the git objects from disk.
      </p>
      <p class="muted small mt">
        Any fork of this repository is detached first — it repacks so it owns
        its objects, then loses the link. Forks survive; this repository does
        not. There is no undo and no backup.
      </p>
      <div class="form-actions">
        ${confirmAction({
          action: `${base}/settings/delete`,
          verb: "Delete this repository",
        })}
      </div>`,
    {
      tone: "danger",
      head: html`${icon("alert")}
        <h2>Delete this repository</h2>`,
    },
  );
  return settingsPageResponse(ctx, repo, "danger", "Danger zone", body);
}

/**
 * The typed-name check lives here and nowhere else: the confirm page collects
 * the phrase, this handler is the one that refuses without it.
 */
export async function repoDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const full = `${repo.ownerName}/${repo.name}`;
  if (field(form, "confirm") !== full) {
    return flashTo(ctx, `${repoBase(repo)}/settings/danger`, {
      tone: "danger",
      message: `Type ${full} exactly to confirm. Nothing was deleted.`,
    });
  }
  const deleted = await deleteRepo(ctx.app, ctx.auth.user, repo);
  if (!deleted.ok) {
    return flashTo(ctx, `${repoBase(repo)}/settings/danger`, {
      tone: "danger",
      message: "The repository could not be deleted.",
    });
  }
  return flashTo(ctx, "/", { message: `${full} was deleted.` });
}

// POST /:owner/:name/settings/crew/:username/role
export async function crewRoleUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const agent = getAgentByName(ctx.app.db, ctx.params.username ?? "");
  const role = field(form, "role");
  if (!agent || !isCrewRole(role))
    return flashTo(ctx, `${base}/settings/crew`, {
      tone: "danger",
      message: "That role could not be set.",
    });
  setCrewRole(ctx.app.db, repo.id, agent.user.id, role);
  return flashTo(ctx, `${base}/settings/crew`, {
    message: `${agent.user.username} is a ${role} here.`,
  });
}

// ---- autonomy ----

/** GET /:owner/:name/settings/autonomy */
export function autonomySettingsPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const status = autonomyStatus(ctx.app, repo);
  const crew = listCrewRoles(ctx.app.db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").length;
  const planner = crew.find((c) => c.role === "planner");
  const state =
    repo.autonomy === "off"
      ? html`<p class="muted small">
          Off. Every run starts because a person assigned, commented, or a check
          failed.
        </p>`
      : html`<p class="small">
          ${repo.autonomy === "autonomous" ? "Autonomous" : "Assisted"} ·
          $${status.spentTodayUsd.toFixed(2)} of
          $${status.ceilingUsd.toFixed(0)} today · ${status.active} of
          ${status.slots} slots in use
          ${status.paused === "ceiling"
            ? html`· <strong>paused at the ceiling</strong>, resumes at 00:00
                UTC`
            : status.paused === "forge ceiling"
              ? html`· <strong>paused at the forge's ceiling</strong>, resumes
                  at 00:00 UTC`
              : status.paused === "no crew"
                ? html`· <strong>paused: no crew</strong>`
                : status.paused === "nobody"
                  ? html`· <strong>paused: nobody to act as</strong>`
                  : null}
        </p>`;
  const form = html`<form method="post" action="${base}/settings/autonomy">
    ${selectField({
      label: "Mode",
      name: "autonomy",
      hint: "Assisted: the crew works what is ready and every green change waits for your look. Autonomous: green ships, and when the map runs dry the planner is given the direction.",
      options: [
        { value: "off", label: "Off", selected: repo.autonomy === "off" },
        {
          value: "assisted",
          label: "Assisted",
          selected: repo.autonomy === "assisted",
        },
        {
          value: "autonomous",
          label: "Autonomous",
          selected: repo.autonomy === "autonomous",
        },
      ],
    })}
    <div class="field">
      <label for="f-direction">Direction</label>
      <textarea
        class="input"
        id="f-direction"
        name="direction"
        rows="3"
        placeholder="Pull the engine out of the game so a second game can use it."
      >
${repo.autonomyDirection}</textarea
      >
      <p class="hint">
        One or two sentences. The planner turns this into issues and links them
        when nothing is left to build.
        ${planner
          ? html`Planner here: ${userLink(planner.agent.user.username)}.`
          : html`No planner on the crew yet — set one under Crew, or the map is
            only what people write.`}
      </p>
    </div>
    ${formField({
      label: "Ceiling per day",
      name: "ceiling",
      value: String(repo.autonomyCeilingUsd),
      type: "number",
      hint: "Dollars of agent spend on this repository per UTC day. At the ceiling the crew stops picking until midnight; nothing in flight is cut.",
    })}
    ${formField({
      label: "Slots",
      name: "slots",
      value: String(repo.autonomySlots),
      type: "number",
      hint: `Agent runs at once here. This is the WIP limit; ${builders} builder${builders === 1 ? "" : "s"} on the crew now.`,
    })}
    <div class="form-actions">${btn("Save", { variant: "primary" })}</div>
  </form>`;
  const body = card(html`${state}${form}`, {
    head: html`<h2>Autonomy</h2>`,
  });
  return settingsPageResponse(ctx, repo, "autonomy", "Autonomy", body);
}

// POST /:owner/:name/settings/autonomy
export async function autonomySettingsUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const mode = field(form, "autonomy");
  const ceiling = Number(field(form, "ceiling"));
  const slots = Number(field(form, "slots"));
  if (
    !isAutonomy(mode) ||
    !Number.isFinite(ceiling) ||
    ceiling < 0 ||
    !Number.isInteger(slots) ||
    slots < 1 ||
    slots > 8
  )
    return flashTo(ctx, `${base}/settings/autonomy`, {
      tone: "danger",
      message:
        "Mode is off, assisted or autonomous; the ceiling is a number of dollars; slots are 1 to 8.",
    });
  const updated = await updateRepoSettings(ctx.app, ctx.auth.user, repo, {
    autonomy: mode,
    autonomyDirection: field(form, "direction").trim().slice(0, 2000),
    autonomyCeilingUsd: ceiling,
    autonomySlots: slots,
    autonomyBy: mode === "off" ? null : (ctx.auth.user?.id ?? null),
  });
  return flashTo(ctx, `${base}/settings/autonomy`, {
    ...(updated.ok
      ? {
          message:
            mode === "off"
              ? "Autonomy is off."
              : mode === "assisted"
                ? "Assisted: the crew works what is ready; green waits for you."
                : "Autonomous: the crew works what is ready and ships on green, as you.",
        }
      : {
          tone: "danger" as const,
          message: "Those settings could not be saved.",
        }),
  });
}
