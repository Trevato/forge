/**
 * Repository settings, admin-only: what the repo is (description, visibility,
 * default branch, protection) and the one door marked danger. The labels
 * pane lives in `labels.ts` and the webhooks pane in `hooks.ts`.
 *
 * Four pages rather than one long scroll, because a settings page you have to
 * hunt through is a settings page people get wrong. Every mutation is its own
 * same-origin POST and every one of them says what happened.
 */

import { POLISH_SHARE_DEFAULT, POLISH_SHARE_MAX } from "../../crew/small_share.ts";
import { appLimitWords } from "../../actions/app_limit.ts";
import { showProvenance } from "../../actions/provenance.ts";
import { getProvenance, parentUrl, sourceLabel } from "../../core/provenance.ts";
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
  domainAddedText,
  domainRefusalText,
  domainRemovedText,
  NO_SUCH_DOMAIN,
} from "../../actions/domain_words.ts";
import {
  egressView,
  grantAppEgress,
  revokeAppEgress,
  type EgressView,
} from "../../actions/egress_grants.ts";
import type { DnsRecord } from "../../apps/domains.ts";
import {
  listAppEnvNames,
  NAME_MAX,
  type AppEnvName,
} from "../../core/app_env.ts";
import {
  APP_ENV_ERRORS,
  APP_ENV_NO_SUCH,
  APP_ENV_NOT_SET,
  SCOPE_WORDS,
} from "../../actions/app_env_words.ts";
import { AUTONOMY_SAID, checkAutonomy, isDecisionsBy } from "../../core/repos.ts";
import { TRANSFER_SAID, TRANSFER_STATUS, transferRepository } from "../../actions/transfer.ts";
import { updateRepoSettings } from "../../actions/repos.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { nameFrame, notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { appVitals, shiftText, speedText as ms, type AppVitals } from "../../apps/vitals.ts";
import type { PreviewData } from "../../apps/data.ts";
import {
  getAppByRepo,
  SLUG_MAX,
  slugFor,
  type AppAccess,
  type AppRecord,
} from "../../core/apps.ts";
import {
  readAppMembers,
  setAppMembersThrough,
} from "../../actions/app_members.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { stopMirroring } from "../../actions/mirror_target.ts";
import { getMirrorTarget, mirrorLine } from "../../core/migrate_mirror.ts";
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
import { daySpark } from "../studio/kpi_row.ts";
import { settingsLead, teamJs } from "../studio/crew.ts";
import { pageTitle } from "../studio/nouns.ts";
import { appHref } from "./apps.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { NOT_CHANGED } from "../edit_words.ts";
import { STOP_APP } from "../danger_words.ts";
import { icon } from "../icons.ts";
import { flashTo, page, redirect } from "../layout.ts";
import type { Flash } from "../flash.ts";
import {
  badge,
  btn,
  card,
  confirmAction,
  field as formField,
  row,
  selectField,
  time,
  tlEvent,
} from "../ui.ts";
import { cutWaveFor } from "../../actions/cut_wave.ts";
import { proposalTokensSection } from "./proposal-tokens.ts";
import { secretsSection } from "./secrets.ts";
import { checkMemoryAt } from "../../apps/check-memory.ts";
import { followSourcesCard, followUpstreamCard } from "./upstream-follow.ts";

type Section =
  | "general"
  | "app"
  | "prompts"
  | "labels"
  | "hooks"
  | "machines"
  | "danger";

/** The repo, but only for someone who administers it. A non-admin is told
 * nothing — the settings tab is not even rendered for them. */
function loadAdminRepo(ctx: Ctx): Repo | undefined {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return undefined;
  return repo;
}

/** `loadAdminRepo` for a GET page: names the session, then the repo read as `repo`. */
export function timedAdminRepo(ctx: Ctx): Repo | undefined {
  nameFrame(ctx.request);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "repo", () => loadAdminRepo(ctx));
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
      label: "Prompts",
      href: `${base}/settings/prompts`,
      icon: "comment" as const,
      current: active === "prompts",
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
      label: "Machines",
      href: `${base}/settings/machines`,
      icon: "terminal" as const,
      current: active === "machines",
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
export function settingsPageResponse(
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
      scriptJs: teamJs,
      body: html`${repoHeader(ctx, repo, "settings", { compact: true })}
      ${settingsLayout(sections(repoBase(repo), active), body)}`,
    },
    status,
  );
}

/** The gate every settings POST passes: admin, same-origin, admin scope. */
export async function adminForm(
  ctx: Ctx,
): Promise<{ repo: Repo; form: Form } | Response> {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return { repo, form };
}

// ---- general ----

/**
 * GET /:owner/:name/settings — the one settings page, for every repository
 * and every viewer who can read it. It leads with what the repository says
 * it is, its crew and how far it may go on its own (`settingsLead`,
 * `studio/crew.ts`); beneath, for an admin, the default branch and its
 * gates and the secrets, with the rest — the app, prompts, labels,
 * webhooks, the danger zone — one quiet section over in the same frame.
 */
export async function settingsPage(
  ctx: Ctx,
  /** A refused move: the owner as typed and the sentence to show beside it. */
  refused?: { owner: string; said: string; status: number },
): Promise<Response> {
  nameFrame(ctx.request);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const [readable, repo] = timePhase(ctx.request, "repo", () => {
    const r = loadRepo(ctx);
    return [r, r ? loadAdminRepo(ctx) : undefined] as const;
  });
  if (!readable) return repoNotFound(ctx);
  const lead = timePhase(ctx.request, "lead", () => settingsLead(ctx, readable));
  if (!repo) {
    return timePhase(ctx.request, "render", () => {
      const proposals = proposalTokensSection(ctx, readable);
      return page({
        ctx,
        title: pageTitle("settings", readable, true),
        crumbs: crumbsFor(readable),
        palette: repoPalette(ctx, readable),
        scriptJs: teamJs,
        body: html`${repoHeader(ctx, readable, "settings", { compact: true })}
      ${lead}${proposals ? html`<div class="mt">${proposals}</div>` : null}`,
      });
    });
  }
  const base = repoBase(repo);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const refs = await timePhaseAsync(ctx.request, "refs", () => listRefs(dir, "refs/heads/"));
  let renderMs = 0;
  let since = performance.now();
  const branches = refs.ok
    ? refs.value.map((r) => r.name.replace("refs/heads/", "")).sort()
    : [];
  const tip = refs.ok
    ? refs.value.find((r) => r.name === `refs/heads/${repo.defaultBranch}`)?.oid
    : undefined;
  renderMs += performance.now() - since;
  const cellMemory = await timePhaseAsync(ctx.request, "check", () => checkMemoryAt(dir, tip));
  since = performance.now();
  if (!branches.includes(repo.defaultBranch))
    branches.unshift(repo.defaultBranch);

  // The lead's About card owns the description and visibility; this form
  // sends them back unchanged, as that one does the gates below.
  const body = html`<section class="settings-block">
    <h2>Branch and gates</h2>
    <p class="muted">
      Where the repository opens, and what must hold before a change lands on it.
    </p>
    <form method="post" action="${base}/settings">
      <input type="hidden" name="card" value="gates" />
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
            >Protect the default branch — no force-push, no deletion, and only
            its admins push it; everyone else lands through a pull. Enforced
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
      <div class="field">
        <input type="hidden" name="crewOutsidersShown" value="1" />
        <label class="check">
          <input
            type="checkbox"
            name="crewOutsiders"
            ${repo.crewOutsiders ? html`checked` : null}
          />
          <span
            >Outsiders may trigger the crew — anyone signed in who can read
            this repository starts and steers runs by commenting, on your
            budget. Off, only people who can write here direct the crew;
            anyone else's words stay on the thread. Turning it on or off is
            recorded in the activity.</span
          >
        </label>
      </div>
      <div class="field">
        <input type="hidden" name="polishShareShown" value="1" />
        <label for="polish-share">Polish share</label>
        <input
          class="input mono"
          id="polish-share"
          type="number"
          name="polishShare"
          min="0"
          max="${String(POLISH_SHARE_MAX)}"
          step="1"
          value="${String(repo.polishShare)}"
          inputmode="numeric"
        />
        <p class="hint">
          Percent of the week's agent spend that polish may take, 0 to ${String(POLISH_SHARE_MAX)}
          (starts at ${String(POLISH_SHARE_DEFAULT)}) — so small fixes get steady attention without crowding out the plan.
          Over it, the crew stops picking issues labelled polish or in the small-fixes lane until the week catches up; the
          <a href="${base}/week">week</a> shows where it stands.
        </p>
      </div>
      ${cellMemory === undefined
        ? null
        : html`<div class="field"><p class="hint" data-check-memory>${
            cellMemory === null
              ? "forge.json's check could not be read, so no limit is shown."
              : cellMemory
          }</p></div>`}
      <div class="form-actions">
        ${btn("Save changes", { variant: "primary" })}
      </div>
    </form>
  </section>`;
  const secrets = secretsSection(ctx, "repo", `${repo.ownerName}/${repo.name}`);
  const upstream = followUpstreamCard(ctx, repo);
  const sources = followSourcesCard(ctx, repo);
  const wave = html`<section class="settings-block">
    <h2>Cut a wave</h2>
    <form method="post" action="${base}/settings/wave">
      <p class="muted">
        Opens a pull that adds the next <code>waves/&lt;version&gt;.md</code>,
        listing every pull merged since the last wave. The headline and
        highlights are left as TODO for you to write.
        <a href="${base}/waves">See the waves so far</a>.
      </p>
      <div class="form-actions">${btn("Cut a wave", { variant: "primary" })}</div>
    </form>
  </section>`;
  const proposals = proposalTokensSection(ctx, repo);
  const trail = provenanceCard(ctx, repo);
  const archive = html`<section class="settings-block">
    <h2>Archive</h2>
    <form method="post" action="${base}/settings/archive">
      <input type="hidden" name="archived" value="${repo.archivedAt === null ? "1" : "0"}" />
      <p class="muted">
        ${repo.archivedAt === null
          ? "Put a finished repository away without deleting it. Its page says when it was archived; links, clone and push keep working."
          : html`Archived on ${repo.archivedAt.slice(0, 10)}. Wake it to take the label off.`}
      </p>
      <div class="form-actions">
        ${btn(repo.archivedAt === null ? "Archive" : "Wake", {
          variant: "primary",
        })}
      </div>
    </form>
  </section>`;
  const move = html`<section class="settings-block">
    <h2>Move to another owner</h2>
    <form method="get" action="/-/confirm">
      <input type="hidden" name="to" value="${base}/settings/transfer" />
      <p class="muted">
        Give the repository to an account or organisation you can create
        repositories under.
      </p>
      ${formField({
        label: "New owner",
        name: "owner",
        value: refused?.owner ?? "",
        required: true,
        maxlength: 64,
        autocomplete: "off",
        spellcheck: false,
        mono: true,
        ...(refused ? { error: refused.said } : {}),
      })}
      <div class="form-actions">${btn("Move", { variant: "danger" })}</div>
    </form>
  </section>`;
  renderMs += performance.now() - since;
  const held = timePhase(ctx.request, "mirror", () => getMirrorTarget(ctx.app.db, repo.id));
  since = performance.now();
  const mirror =
    held === undefined
      ? null
      : html`<section class="settings-block">
          <h2>Mirror</h2>
          <p class="muted" data-mirror-line>${mirrorLine(held)}</p>
            <p class="muted small">
              Stopping leaves ${held.fullName} as it is; nothing more is pushed.
            </p>
            <div class="form-actions">
              ${confirmAction({
                action: `${base}/settings/mirror/stop`,
                verb: "Stop mirroring",
              })}
            </div>
        </section>`;
  const response = settingsPageResponse(
    ctx,
    repo,
    "general",
    "Settings",
    html`${lead}${mirror ? html`<div class="mt">${mirror}</div>` : null}<div class="mt">${body}</div>${trail
      ? html`<div class="mt">${trail}</div>`
      : null}${upstream ? html`<div class="mt">${upstream}</div>` : null}${sources ? html`<div class="mt">${sources}</div>` : null}<div class="mt">${wave}</div><div class="mt">${archive}</div><div class="mt">${move}</div>${proposals
      ? html`<div class="mt">${proposals}</div>`
      : null}${secrets
      ? html`<div class="mt">${secrets}</div>`
      : null}`,
    undefined,
    refused?.status,
  );
  notePhase(ctx.request, "render", renderMs + performance.now() - since);
  return response;
}

/** A form's polish share: the number if it is all digits, else NaN, which the action refuses. */
const parseShare = (raw: string): number => (/^\d{1,3}$/.test(raw.trim()) ? Number(raw) : Number.NaN);

export async function settingsUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const branch = field(form, "defaultBranch");

  // The page has two forms over this one route, and each changes only its
  // own fields: About its words and visibility, Branch and gates the rest.
  // A form that names no card (an older client) sends them all, as before.
  // A checkbox that is off sends nothing, so a card that never drew it must
  // never read its absence as "off".
  const card = field(form, "card");
  const about = {
    description: field(form, "description"),
    visibility:
      field(form, "visibility") === "public"
        ? ("public" as const)
        : ("private" as const),
  };
  const gates = {
    protectDefault: form.get("protect") !== null,
    requireReview: form.get("requireReview") !== null,
    requireChecks: form.get("requireChecks") !== null,
    // Who directs the crew changes only from a form that shows the switch:
    // a form without it (the studio's About card) never turns it off by
    // leaving it out.
    ...(form.get("crewOutsidersShown") !== null
      ? { crewOutsiders: form.get("crewOutsiders") !== null }
      : {}),
    ...(branch !== "" ? { defaultBranch: branch } : {}),
    // Sent only by a form that draws the field; anything but a whole 0–50 is refused by the action.
    ...(form.get("polishShareShown") !== null ? { polishShare: parseShare(field(form, "polishShare")) } : {}),
  };
  const updated = await updateRepoSettings(
    ctx.app,
    ctx.auth.user,
    repo,
    card === "about" ? about : card === "gates" ? gates : { ...about, ...gates },
  );
  const flash: Flash = updated.ok
    ? { message: "Settings saved." }
    : {
        tone: "danger",
        message:
          updated.error === "unknown_branch"
            ? "That branch does not exist in this repository."
            : updated.error === "polish_share"
            ? `Polish share is a whole number of percent, 0 to ${POLISH_SHARE_MAX}.`
            : "Those settings could not be saved.",
      };
  return flashTo(ctx, `${base}/settings`, flash);
}

/** A return address that stays on this origin, as a path; anything else is undefined. */
function samePath(ctx: Ctx, to: string | undefined): string | undefined {
  if (to === undefined || !to.startsWith("/") || to.startsWith("//") || /[\\\x00-\x1f]/.test(to))
    return undefined;
  const parsed = URL.parse(to, ctx.url.origin);
  if (!parsed || parsed.origin !== ctx.url.origin) return undefined;
  return parsed.pathname + parsed.search;
}

/**
 * POST /:owner/:name/settings/archive — archive or wake. The state asked
 * for travels in the form, so a double submit is idempotent.
 */
export async function archiveSubmit(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const asked = field(form, "archived");
  if (asked !== "0" && asked !== "1")
    return flashTo(ctx, `${repoBase(repo)}/settings`, {
      tone: "danger",
      message: NOT_CHANGED,
    });
  const archived = asked === "1";
  const updated = await updateRepoSettings(ctx.app, ctx.auth.user, repo, {
    archived,
  });
  const to = field(form, "to");
  const back =
    to === "repo"
      ? repoBase(repo)
      : (samePath(ctx, to) ?? `${repoBase(repo)}/settings`);
  return flashTo(
    ctx,
    back,
    updated.ok
      ? { message: archived ? "Archived." : "Awake again." }
      : { tone: "danger", message: NOT_CHANGED },
  );
}

/**
 * POST /:owner/:name/settings/transfer — move the repository to another
 * owner, through the action (never core). A refusal is the settings page
 * again, with the sentence beside the field and the field as typed.
 */
export async function transferSubmit(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const owner = (field(form, "owner") ?? "").trim();
  const refuse = (said: string, status: number) =>
    settingsPage(ctx, { owner: owner.slice(0, 64), said, status });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(owner))
    return refuse(TRANSFER_SAID.unknown_owner, TRANSFER_STATUS.unknown_owner);
  const moved = await transferRepository(ctx.app, ctx.auth.user, repo, owner);
  if (!moved.ok) {
    if (moved.error === "not_found") return repoNotFound(ctx);
    return refuse(TRANSFER_SAID[moved.error], TRANSFER_STATUS[moved.error]);
  }
  return flashTo(ctx, `${repoBase(moved.value)}/settings`, {
    message: `Moved to ${moved.value.ownerName}/${moved.value.name}.`,
  });
}

/**
 * "Show where this came from" (#3293), drawn only for a repository that
 * has a trail to show: the line as it reads, and the one switch for it.
 */
function provenanceCard(ctx: Ctx, repo: Repo): Html | null {
  const trail = getProvenance(ctx.app.db, repo.id);
  if (trail === undefined) return null;
  const base = repoBase(repo);
  return html`<section class="settings-block">
    <h2>Show where this came from</h2>
    <form method="post" action="${base}/settings/provenance">
      <input type="hidden" name="shown" value="${trail.shown ? "0" : "1"}" />
      <p class="muted">
        Migrated from
        <a href="${trail.sourceUrl}" rel="noopener noreferrer"
          >${sourceLabel(trail.sourceUrl)}</a
        >${trail.parents.map(
          (p) =>
            html` · fork of
              <a href="${parentUrl(trail.sourceUrl, p)}" rel="noopener noreferrer"
                >${p}</a
              >`,
        )}
        on ${trail.migratedAt.slice(0, 10)}.
        ${trail.shown
          ? "Shown under the repository's name on every page and in the API. Hiding it keeps the record, so it can come back."
          : "Hidden: nobody else sees it, on a page or in the API. The record is kept."}
      </p>
      <div class="form-actions">
        ${btn(trail.shown ? "Hide where this came from" : "Show where this came from", {
          variant: "outline",
        })}
      </div>
    </form>
  </section>`;
}

/** POST /:owner/:name/settings/provenance — show or hide the trail. */
export async function provenanceSubmit(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const asked = field(form, "shown");
  const back = `${repoBase(repo)}/settings`;
  if (asked !== "0" && asked !== "1")
    return flashTo(ctx, back, { tone: "danger", message: NOT_CHANGED });
  const set = showProvenance(ctx.app, ctx.auth.user, repo, asked === "1");
  return flashTo(
    ctx,
    back,
    set.ok
      ? { message: set.value.shown ? "Where this came from is shown." : "Where this came from is hidden." }
      : { tone: "danger", message: NOT_CHANGED },
  );
}

/** POST /:owner/:name/settings/mirror/stop — stop mirroring to the source. */
export async function mirrorStop(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const stopped = stopMirroring(ctx.app, ctx.auth.user, repo);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings`,
    stopped.ok && stopped.value
      ? { message: "Stopped mirroring." }
      : { tone: "danger", message: "This repository is not being mirrored." },
  );
}

/** POST /:owner/:name/settings/wave — open the draft of the next wave. */
export async function waveCut(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const cut = await cutWaveFor(ctx.app, ctx.auth.user, repo);
  if (!cut.ok)
    return flashTo(ctx, `${repoBase(repo)}/settings`, {
      tone: "danger",
      message: cut.error,
    });
  return flashTo(ctx, `${repoBase(repo)}/pulls/${cut.value.number}`, {
    message: `Wave ${cut.value.version} is open as a draft.`,
  });
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
  egress?: EgressView,
): Html {
  const base = repoBase(repo);
  const runtime = appsRuntime(ctx.app);
  const domain = runtime?.options.domain;
  const listed =
    record === undefined
      ? undefined
      : readAppMembers(ctx.app, ctx.auth.user, repo);
  const named = listed?.ok === true ? listed.value.members : [];
  const form = html`<section class="settings-block" id="app">
    <h2>${record === undefined ? "Run as an app" : "App"}</h2>
    ${when(
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
              : `Right now a visitor is asked to sign in and let through only if they can write this repository, are on its crew, or are named under Who may enter (${named.length === 0 ? "nobody is" : named.join(", ")}); reading the code is not enough, so it stays this way if the repository is made public. Everyone else sees not found. Choose Public to share it with anyone.`,
          options: [
            {
              value: "private",
              label: "Private — people who can write this repository",
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
              href: appHref(repo),
              variant: "ghost",
              icon: "rocket",
            }),
          )}
        </div>
      </form>
  </section>`;
  if (record === undefined) return form;
  const domains = timePhase(ctx.request, "domains", () =>
    listAppDomains(ctx.app, ctx.auth.user, repo),
  );
  const vitals = timePhase(ctx.request, "vitals", () =>
    appVitals(ctx.app.db, record.id),
  );
  return html`${form}
    ${when(listed?.ok === true, () => html`<div class="mt">${appMembersView(base, values.access, named)}</div>`)}
    <div class="mt">${appVisitorsView(vitals)}</div>
    <div class="mt">
      ${appEnvView(base, listAppEnvNames(ctx.app.db, record.id))}
    </div>
    <div class="mt">
      ${appDomainsView(base, domains.ok ? domains.value : undefined)}
    </div>
    ${when(egress !== undefined, () => html`<div class="mt">${appEgressView(base, egress!)}</div>`)}
    <div class="mt">
      ${card(
        html`<p>
            Production and every preview stop, and their data directories and
            checkouts are removed. The repository and its code are untouched.
          </p>
          <div class="form-actions">
            ${confirmAction({
              action: `${base}/settings/app/disable`,
              verb: STOP_APP,
            })}
          </div>`,
        {
          tone: "danger",
          head: html`${icon("alert")}
            <h2>${STOP_APP}</h2>`,
        },
      )}
    </div>`;
}

/** Production's visitors and the speed they saw, from the app's own beacon. */
export function appVisitorsView(v: AppVitals): Html {
  const known = v.loadDays.filter((n): n is number => n !== null);
  const latest = v.loadDays.findLast((n) => n !== null) ?? null;
  const spark = daySpark(
    v.loadDays,
    known.length === 0
      ? "p75 load each day over the last 30 days"
      : `p75 load each day over the last 30 days, latest ${ms(latest ?? undefined)}, range ${ms(Math.min(...known))} to ${ms(Math.max(...known))}`,
  );
  return html`<section class="settings-block" id="visitors">
    <h2>Visitors and speed</h2>
    <p class="muted small mb">
      Counted by the beacon, with no address kept; the 7 day figure adds
      the days up. <a href="app/traffic">Where visitors come from</a>
    </p>
      <dl class="stats">
        <div><dt>Visitors today</dt><dd>${v.today}</dd></div>
        <div><dt>Visitors, 7 days</dt><dd>${v.week}</dd></div>
        <div><dt>p75 TTFB</dt><dd>${ms(v.ttfbP75)}</dd></div>
        <div><dt>p75 load</dt><dd>${ms(v.loadP75)}</dd></div>
        <div><dt>p75 LCP</dt><dd>${ms(v.lcpP75)}</dd></div>
        <div><dt>p75 INP</dt><dd>${ms(v.inpP75)}</dd></div>
        <div><dt>p75 CLS</dt><dd>${shiftText(v.clsP75)}</dd></div>
      </dl>
      ${spark ? html`<div class="bar muted">${spark}</div>` : html`<p class="muted small mt">No load reports in the last 30 days</p>`}
  </section>`;
}

/**
 * The app's environment: the names that are set, and a form for one more.
 * Values are write-only — the page shows a name and when it was set, and
 * the value input forgets what was typed the moment the form is sent.
 */
export function appEnvView(base: string, names: AppEnvName[]): Html {
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
  return html`<section class="settings-block" id="environment">
    <h2>Environment</h2>
    <p class="muted small">
      What the app reads at start-up; values are write-only, and one set
      for production only or previews only wins there over one set everywhere.
    </p>
      ${when(
        rows.length > 0,
        () =>
          html`<ul class="list setting-list">
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
      </form>
  </section>`;
}

/**
 * The app's own domains: each with what the last check said, the records
 * to publish while it waits, and a form for one more. The forge serves a
 * domain the moment it is verified; the app itself hears its new address
 * at its next deploy, because a process reads its URL once, at start.
 * `undefined` is a forge where nothing serves apps: a domain would have
 * nowhere to point, so the card says so and offers no form.
 */
/**
 * Who may enter a private app beyond its writers and crew (#752): one
 * username a line. Being named opens the app and its previews and nothing
 * else — no code, no crew, no settings, no terminal.
 */
function appMembersView(
  base: string,
  access: AppAccess,
  named: readonly string[],
): Html {
  return html`<section class="settings-block" id="members">
    <h2>${icon("users")} Who may enter</h2>
    <form method="post" action="${base}/settings/app/members">
      <div class="field">
        <label for="f-members">People</label>
        <textarea
          class="input mono"
          id="f-members"
          name="members"
          rows="${Math.min(10, Math.max(3, named.length + 1))}"
          autocomplete="off"
          spellcheck="false"
          placeholder="one username a line"
        >
${named.join("\n")}</textarea
        >
        <p class="hint">
          ${access === "private"
            ? "They may open the app and its previews, and nothing else: not the code, the crew, the settings or the terminal. Removing a name shuts them out at once. What the app itself shows them is the app's to decide: it runs with your read-only token, so anything it shows visitors from the forge, they see too."
            : "The app is public, so anyone may open it now; these names matter once it is private."}
        </p>
      </div>
      <div class="form-actions">${btn("Save people", { variant: "primary" })}</div>
    </form>
  </section>`;
}

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
          <div class="row-main">
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
            ${when(!d.verified, () => recordsToPublish(d.host, d.records))}
          </div>
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
  return html`<section class="settings-block" id="domains">
    <h2>${icon("globe")} Domains</h2>
        <p class="muted small mb">
          Serve the app at a name of your own —
          <span class="mono">app.example.com</span>, or an apex. Add it, publish
          the two records it shows, and press Check now.
        </p>
      ${when(
        rows.length > 0,
        () =>
          html`<ul class="list setting-list">
            ${rows}
          </ul>`,
      )}
      ${domains === undefined
        ? html`<p class="muted small">
              Nothing is serving apps on this forge, so a domain would have
              nowhere to point.
            </p>`
        : html`<p class="muted small mb">
              The forge serves the app there as soon as the record is
              verified. The app itself learns its new address at its next
              deploy.
            </p>
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
            </form>`}
  </section>`;
}

/** The records as a person copies them into a zone: type, name, value. */
function recordsToPublish(host: string, records: DnsRecord[]): Html {
  return html`<div
      class="table-scroll"
      role="region"
      tabindex="0"
      aria-label="DNS records for ${host}"
    >
      <table class="table" data-dense>
        <caption class="sr-only">
          DNS records for ${host}
        </caption>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          ${records.map(
            (r) =>
              html`<tr>
                <td>${badge(r.type, { variant: "outline" })}</td>
                <td class="mono">${r.name}</td>
                <td class="mono record-value" title="${r.value}">
                  ${r.value}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${records
      .filter((r) => r.note !== undefined)
      .map((r) => html`<span class="row-meta">${r.note}</span>`)}`;
}

const appValues = (repo: Repo, record: AppRecord | undefined): AppValues => ({
  slug: record?.slug ?? slugFor(repo.name),
  access: record?.access ?? repo.visibility,
  previewData: record?.previewData ?? "copy",
});

// GET /:owner/:name/settings/app
export async function appSettingsPage(ctx: Ctx): Promise<Response> {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const record = getAppByRepo(ctx.app.db, repo.id);
  const egress =
    record === undefined
      ? undefined
      : await egressView(ctx.app, ctx.auth.user, repo);
  const view = appSettingsView(
    ctx,
    repo,
    record,
    appValues(repo, record),
    undefined,
    egress?.ok ? egress.value : undefined,
  );
  const rendering = performance.now();
  const response = settingsPageResponse(ctx, repo, "app", "App", view);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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
        saved.error === "app_limit"
          ? appLimitWords(ctx.app, repo.ownerId)
          : (APP_ERRORS[saved.error] ?? "Those settings could not be saved."),
      ),
      undefined,
      422,
    );
  }
  const url = appsRuntime(ctx.app)?.urlFor(saved.value, "production");
  return flashTo(
    ctx,
    record === undefined
      ? appHref(repo)
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

// POST /:owner/:name/settings/app/members — the whole list, one a line.
export async function appMembersUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const members = field(form, "members").split(/[\s,]+/).filter((n) => n !== "");
  const set = setAppMembersThrough(ctx.app, ctx.auth.user, repo, {
    members,
    dryRun: false,
  });
  const to = `${repoBase(repo)}/settings/app`;
  if (!set.ok)
    return flashTo(ctx, to, {
      tone: "danger",
      message:
        set.error.kind === "invalid"
          ? set.error.message
          : "Only a person who can write here chooses who may enter.",
    });
  const { added, removed } = set.value;
  return flashTo(ctx, to, {
    message:
      added.length === 0 && removed.length === 0
        ? "Nobody changed."
        : [
            added.length > 0 ? `${added.join(", ")} may enter` : "",
            removed.length > 0 ? `${removed.join(", ")} no longer may` : "",
          ]
            .filter((s) => s !== "")
            .join("; ") + ".",
  });
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
            APP_ENV_ERRORS[set.error] ?? APP_ENV_NOT_SET,
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
      : { tone: "danger", message: APP_ENV_NO_SUCH },
  );
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
          message: domainAddedText(added.value),
        }
      : {
          tone: "danger",
          message:
            domainRefusalText(added.error, "That domain could not be added."),
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
            domainRefusalText(checked.error, NO_SUCH_DOMAIN),
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
      ? { message: domainRemovedText(host) }
      : { tone: "danger", message: NO_SUCH_DOMAIN },
  );
}

/**
 * The private destinations forge.json asks for (#3433), each with who
 * granted it; Grant and Revoke only for a site admin. The last few changes
 * follow, so a revoke is still on the page after the grant is gone.
 */
function appEgressView(base: string, egress: EgressView): Html {
  const at = (destination: string) =>
    `${base}/settings/app/egress/${encodeURIComponent(destination)}`;
  const rows = egress.rows.map((r) =>
    row({
      lead: icon("globe"),
      title: html`<span class="mono">${r.destination}</span> ${r.granted
          ? badge("granted", { tone: "success" })
          : badge("not granted", { tone: "attn" })}
        ${r.asked ? null : badge("no longer asked")}`,
      meta:
        r.granted && r.grantedAt !== null
          ? html`Granted by ${r.grantedBy ?? "someone"} ${time(r.grantedAt)}`
          : html`Nothing reaches it until a site admin grants it.`,
      trail: egress.canChange
        ? html`<div class="row-fields">
            ${r.granted
              ? confirmAction({
                  action: `${at(r.destination)}/revoke`,
                  verb: "Revoke",
                  size: "sm",
                })
              : html`<form method="post" action="${at(r.destination)}/grant">
                  ${btn("Grant", { size: "sm", variant: "outline" })}
                </form>`}
          </div>`
        : html``,
    }),
  );
  const changes = egress.changes.map(
    (c) =>
      tlEvent({
        icon: "globe",
        body: html`<span class="muted small"
          >${c.by} ${c.kind} <span class="mono">${c.destination}</span>
          ${time(c.at)}</span
        >`,
      }),
  );
  return html`<section class="settings-block" id="egress">
    <h2>Private destinations asked for</h2>
    ${rows.length === 0
      ? html`<p class="muted small">
          This app reaches only the forge; every other host is refused.
        </p>`
      : html`<p class="muted small">
            Each is an exact address and port forge.json asks for; every other
            host is refused.${egress.canChange
              ? null
              : " Only a site admin grants or revokes."}
          </p>
          <ul class="list setting-list">
            ${rows}
          </ul>`}
    ${when(
      changes.length > 0,
      () => html`<div class="timeline">${changes}</div>`,
    )}
  </section>`;
}

const EGRESS_ERRORS: Record<string, string> = {
  forbidden: "Only a site admin grants or revokes a private destination.",
  invalid_destination: "That is not an address and port.",
  not_asked: "forge.json does not ask for that destination.",
  never_grantable:
    "That address can never be granted: it is this machine, link-local or the forge's own cluster.",
  no_such_grant: "There was no grant for that destination.",
};

// POST /:owner/:name/settings/app/egress/:destination/grant
export async function appEgressGrant(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const destination = ctx.params.destination ?? "";
  const granted = await grantAppEgress(ctx.app, ctx.auth.user, repo, destination);
  if (!granted.ok && granted.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    granted.ok
      ? { message: `${granted.value.destination} is granted.` }
      : {
          tone: "danger",
          message: EGRESS_ERRORS[granted.error] ?? "That could not be granted.",
        },
  );
}

// POST /:owner/:name/settings/app/egress/:destination/revoke
export async function appEgressRevoke(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const destination = ctx.params.destination ?? "";
  const revoked = revokeAppEgress(ctx.app, ctx.auth.user, repo, destination);
  if (!revoked.ok && revoked.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/app`,
    revoked.ok
      ? { message: `${revoked.value} is revoked.` }
      : {
          tone: "danger",
          message: EGRESS_ERRORS[revoked.error] ?? "That could not be revoked.",
        },
  );
}

/** What a change to the environment sets in motion — when anything serves. */
function redeploying(ctx: Ctx, how: string): string {
  return appsRuntime(ctx.app) === undefined
    ? ""
    : ` Production and every preview are starting again ${how}.`;
}

// ---- autonomy ----

/** GET /:owner/:name/settings/autonomy */
// GET /:owner/:name/settings/autonomy — the settings page's own card now.
export function autonomySettingsPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  return redirect(`${repoBase(repo)}/settings#autonomy`);
}

// POST /:owner/:name/settings/autonomy
export async function autonomySettingsUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const ceiling = Number(field(form, "ceiling"));
  // The builders' slots are the Builder pillar's number on the team card; this form only keeps them.
  const slotsField = field(form, "slots");
  const slots = slotsField === "" ? repo.autonomySlots : Number(slotsField);
  const checked = checkAutonomy(field(form, "autonomy"), ceiling, slots);
  if (!checked.ok)
    return flashTo(ctx, `${base}/settings#autonomy`, {
      tone: "danger",
      message: checked.message,
    });
  const { mode } = checked;
  const rule = field(form, "decisions");
  const decisionsBy = rule === "" ? repo.decisionsBy : rule;
  if (!isDecisionsBy(decisionsBy))
    return flashTo(ctx, `${base}/settings#autonomy`, {
      tone: "danger",
      message: "Decisions here go to you, the decider, or the decider telling you.",
    });
  const updated = await updateRepoSettings(ctx.app, ctx.auth.user, repo, {
    autonomy: mode,
    autonomyDirection: field(form, "direction").trim().slice(0, 2000),
    autonomyCeilingUsd: ceiling,
    autonomySlots: slots,
    autonomyBy: mode === "off" ? null : (ctx.auth.user?.id ?? null),
    // Only a change is sent: an agent admin may save the rest of the form.
    ...(decisionsBy === repo.decisionsBy ? {} : { decisionsBy }),
  });
  return flashTo(ctx, `${base}/settings#autonomy`, {
    ...(updated.ok
      ? { message: AUTONOMY_SAID[mode] }
      : {
          tone: "danger" as const,
          message: "Those settings could not be saved.",
        }),
  });
}
