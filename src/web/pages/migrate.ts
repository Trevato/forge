/**
 * Migrate on the web: the form behind "+" → Migrate, and the page that
 * watches the clone. A repository comes from one of your origins or from a
 * pasted URL, lands under an owner and a name you choose, and — when you
 * put a crew on it — becomes an app the crew is already making run.
 *
 * GitHub connects from here too ("Connect GitHub" runs the origins'
 * device flow and comes back), and is disconnected from here. Each of your
 * repositories there is a row; one click on a row migrates it with the crew
 * picked below — issues and open pull requests included.
 *
 * A row's Branches link draws that repository's branches with their last
 * commits and selects the one the app most likely lives on — the person's
 * newest (`origins/work-branch.ts`); the Migrate button carries the choice.
 *
 * An account whose token sees public repositories only says so under its account
 * (`origins/token-reach.ts`), with GitHub's new-token page one click away
 * and a field that replaces the token in place.
 *
 * Every mutation is `migrateRepo`; the page only puts its answer into words.
 */

import { repositoryLimitMessage } from "../../actions/repos.ts";
import { listAllAgents } from "../../actions/crew.ts";
import {
  migrateMessage,
  afterChoice,
  migrateRepo,
  migrationJobFor,
  type AfterMigration,
  type MigrateSource,
} from "../../actions/migrate.ts";
import { listRemoteRepos, listUserOrigins } from "../../actions/origins.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import { getOriginFor, type OriginRepoRow } from "../../core/origins.ts";
import { providerForOrigin } from "../../origins/credential.ts";
import {
  cachedRemoteTips,
  pickWorkBranch,
  type BranchTip,
} from "../../origins/work-branch.ts";
import { scopeAllows } from "../../core/tokens.ts";
import {
  notePhase,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
} from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import type { MirrorJob, MirrorStage } from "../../origins/jobs.ts";
import { notFoundPage, pageHead, signInFirst, NOT_YOURS_TO_DO, forbiddenPage } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, raw, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import {
  badge,
  btn,
  icon,
  row,
  selectField,
  field as formField,
} from "../ui.ts";
import {
  FINE_GRAINED_NOTE,
  PUBLIC_ONLY,
  newTokenUrl,
  tokenReach,
} from "../../origins/token-reach.ts";
import type { TokenReach } from "../../origins/types.ts";
import { STAGE_BADGE_JS, stageRow, stageStateFor } from "../stage-row.ts";
import { prefill, originHost, migrationBuilders } from "./migrate-prefill.ts";
import { githubConnectable, hostLabel } from "./origins.ts";

interface MigrateValues {
  source: string;
  /** The picker's filter: rows whose name or description holds it. */
  q: string;
  url: string;
  owner: string;
  name: string;
  visibility: string;
  agent: string;
  autonomous: boolean;
  after: AfterMigration;
  /** The branch asked for; "" lets the work-branch rule choose. */
  branch: string;
  /** Draw the picked repository's branches: Branches was pressed, or one was chosen. */
  showBranches: boolean;
}

/** The picked repository's branches, and the one selected. */
interface BranchChoices {
  readonly fullName: string;
  readonly sourceDefault: string;
  readonly tips: readonly BranchTip[];
  readonly selected: string | undefined;
}

/** An origin's repositories, for the picker; an origin that cannot answer is left out. */
interface OriginChoices {
  readonly label: string;
  readonly id: string;
  readonly kind: string;
  readonly host: string;
  readonly webUrl: string;
  readonly repos: readonly OriginRepoRow[];
  /** What its token sees; undefined when the origin names no limit. */
  readonly reach: TokenReach | undefined;
}

/** Every origin you connected; one that cannot list has no rows. */
async function originChoices(ctx: Ctx): Promise<OriginChoices[]> {
  const user = ctx.auth.user!;
  const out: OriginChoices[] = [];
  for (const origin of listUserOrigins(ctx.app, user)) {
    const [listed, reach] = await Promise.all([
      listRemoteRepos(ctx.app, user, origin.id),
      tokenReach(ctx.app, origin),
    ]);
    out.push({
      id: origin.id,
      kind: origin.kind,
      host: originHost(origin.webUrl),
      webUrl: origin.webUrl,
      label: `${origin.login} @ ${hostLabel(origin.webUrl)}`,
      repos: listed.ok ? listed.value : [],
      reach,
    });
  }
  return out;
}

/**
 * The branches of the repository `source` names, when it is one of the
 * picker's rows: read through its origin, with the selection the work-branch
 * rule makes — or the branch asked for, when it is one of them.
 */
async function branchChoices(
  ctx: Ctx,
  origins: readonly OriginChoices[],
  source: string,
  asked: string,
): Promise<BranchChoices | undefined> {
  const picked = source === "" ? undefined : parsePick(source);
  if (picked === undefined || "url" in picked) return undefined;
  const row = origins
    .find((o) => o.id === picked.originId)
    ?.repos.find((r) => r.fullName === picked.fullName);
  const user = ctx.auth.user!;
  const origin = getOriginFor(ctx.app.db, user.id, picked.originId);
  if (row === undefined || origin === undefined) return undefined;
  const provider = providerForOrigin(ctx.app, origin);
  if (!provider.ok) return undefined;
  const tips = await cachedRemoteTips(origin.id, provider.value, row.fullName, {
    logins: [origin.login, user.username],
    emails: [user.email],
  });
  if (tips === undefined || tips.length === 0) return undefined;
  return {
    fullName: row.fullName,
    sourceDefault: row.defaultBranch,
    tips,
    selected: tips.some((t) => t.name === asked)
      ? asked
      : pickWorkBranch(tips, row.defaultBranch),
  };
}

/**
 * One radio per branch, newest first: its last commit's subject, author
 * and date (UTC), the source's default marked, the person's own marked.
 */
function branchList(choices: BranchChoices): Html {
  const rows = [...choices.tips].sort(
    (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
  );
  return html`<div class="field" id="migrate-branches">
    <label>Branch the app lives on — ${choices.fullName}</label>
    <ul class="list">
      ${rows.map((tip) =>
        row({
          data: { branch: tip.name },
          title: html`<label class="check">
            <input
              type="radio"
              name="branch"
              value="${tip.name}"
              ${tip.name === choices.selected ? raw("checked") : null}
            />
            <span class="mono">${tip.name}</span>
          </label>`,
          ...(tip.date === ""
            ? {}
            : {
                meta: html`${tip.subject} · ${tip.author} ·
                  <time datetime="${tip.date}">${tip.date.slice(0, 10)}</time>`,
              }),
          trail: html`${tip.name === choices.sourceDefault
            ? badge("default there")
            : null}${tip.mine ? badge("yours") : null}`,
        }),
      )}
    </ul>
    <span class="hint"
      >Every branch comes; this one becomes the default branch here, and the
      crew is told the app is on it. Selected: the branch with your newest
      commits, else the origin's default.</span
    >
  </div>`;
}

/** Rows drawn per origin; past it, the filter narrows. */
export const PICKER_ROWS = 200;

/**
 * A size an origin reported in KiB, in the unit that keeps it short:
 * 1 KiB = 1024 bytes, 1 MiB = 1024 KiB. 0 is "not reported" — GitHub says
 * 0 for an empty repository too — so it draws nothing.
 */
export function formatKib(kib: number): string {
  if (!Number.isFinite(kib) || kib <= 0) return "";
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
  const gib = mib / 1024;
  return `${gib < 10 ? gib.toFixed(1) : Math.round(gib)} GiB`;
}

/** Whether a row answers the filter: name or description, any case. */
export function matchesFilter(
  repo: Pick<OriginRepoRow, "fullName" | "description">,
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  return (
    needle === "" ||
    repo.fullName.toLowerCase().includes(needle) ||
    repo.description.toLowerCase().includes(needle)
  );
}

/**
 * Under an account whose token lists public repositories only: why the
 * private ones are missing, where to make a token that sees them, and the
 * field that puts it on this origin without disconnecting it.
 */
function publicOnly(origin: OriginChoices): Html {
  return html`<div class="mt" id="migrate-reach-${origin.id}" data-reach="public">
    <p class="small">${icon("lock")} ${PUBLIC_ONLY} — ${origin.label}.</p>
    <p class="small">
      <a href="${newTokenUrl(origin.webUrl)}" target="_blank" rel="noopener noreferrer"
        >Make a token with <span class="mono">repo</span> on GitHub</a
      >
    </p>
    <form method="post" action="/settings/origins/${origin.id}/token">
      <input type="hidden" name="then" value="migrate" />
      ${formField({
        label: `New token for ${origin.label}`,
        name: "token",
        type: "password",
        hint: `${FINE_GRAINED_NOTE}.`,
        mono: true,
        required: true,
        autocomplete: "off",
        id: `f-token-${origin.id}`,
      })}
      ${btn("Replace", { size: "sm", variant: "outline", type: "submit" })}
    </form>
  </div>`;
}

/**
 * The accounts half, outside the migrate form (forms do not nest): each
 * connected origin with a Disconnect, and Connect GitHub when there is no
 * GitHub account yet. Both come back here (`then=migrate`).
 */
function accounts(ctx: Ctx, origins: readonly OriginChoices[]): Html {
  const hasGithub = origins.some((o) => o.kind === "github");
  const connect = hasGithub
    ? null
    : githubConnectable(ctx)
      ? html`<form method="post" action="/settings/origins/oauth" class="bar">
          <input type="hidden" name="kind" value="github" />
          <input type="hidden" name="then" value="migrate" />
          ${btn("Connect GitHub", { variant: "outline", icon: "github", type: "submit" })}
          <span class="muted small"
            >A short code you type at github.com — no token to paste. Your
            private repositories and their issues come too.</span
          >
        </form>`
      : html`<p class="muted small">
          ${icon("github")} Connect GitHub needs this forge's GitHub
          application, set up once under
          <a href="/settings/origins">Settings → Connected accounts</a>; a token pasted
          there works until then.
        </p>`;
  return html`<section class="mb" id="migrate-accounts-section">
    <h2 class="mb">Your accounts</h2>
    ${origins.length === 0
      ? null
      : html`<ul class="list" id="migrate-accounts">
          ${origins.map((origin) =>
            row({
              lead: icon(origin.kind === "github" ? "github" : "globe"),
              title: origin.label,
              meta: html`${origin.repos.length} repositories`,
              trail: html`<form
                method="post"
                action="/settings/origins/${origin.id}/delete"
              >
                <input type="hidden" name="then" value="migrate" />
                ${btn("Disconnect", { size: "sm", variant: "ghost", type: "submit" })}
              </form>`,
            }),
          )}
        </ul>`}
    ${origins.filter((o) => o.reach === "public").map(publicOnly)}
    ${connect}
  </section>`;
}

/**
 * One row per repository: name, private mark, size, description, and the
 * button that migrates it. The buttons are the form's submitters
 * (`name="pick"`), so one click carries the destination and crew fields
 * below with it.
 */
function picker(
  origins: readonly OriginChoices[],
  values: MigrateValues,
  withCrew: boolean,
  branches: BranchChoices | undefined,
): Html {
  const listed = origins.filter((o) => o.repos.length > 0);
  if (listed.length === 0)
    return html`<p class="muted small mb">
      ${icon("globe")} Connect an account above — or another forge under
      <a href="/settings/origins">Settings → Connected accounts</a> — to pick from your
      repositories there, private ones included.
    </p>`;
  return html`<div class="field" id="migrate-picker">
    <label for="f-q">Your repositories</label>
    <div class="bar">
      <input
        class="input"
        type="search"
        id="f-q"
        name="q"
        form="migrate-search"
        value="${values.q}"
        placeholder="Filter by name or description"
        autocomplete="off"
        enterkeyhint="search"
      />
      ${btn("Filter", { variant: "outline", type: "submit", form: "migrate-search", icon: "search" })}
    </div>
    ${values.source === ""
      ? null
      : html`<input type="hidden" name="source" value="${values.source}" />`}
    ${listed.map((origin) => {
      const rows = origin.repos.filter((r) => matchesFilter(r, values.q));
      const shown = rows.slice(0, PICKER_ROWS);
      return html`<h4 class="mt small muted">${origin.label}</h4>
        <ul class="list" data-pick-rows>
          ${shown.map((remote) => {
            const value = pickValue(origin.id, remote.fullName);
            const size = formatKib(remote.sizeKb);
            const branches = `/migrate?${new URLSearchParams({
              source: value,
              branches: "1",
              ...(values.q === "" ? {} : { q: values.q }),
            })}#migrate-branches`;
            return row({
              data: {
                q: `${remote.fullName} ${remote.description}`.toLowerCase(),
              },
              current: values.source === value,
              title: html`<span class="mono">${remote.fullName}</span>
                ${remote.private ? badge("private") : null}`,
              meta: html`${size === "" ? null : html`${size} · `}${remote.description}`,
              trail: html`${btn("Branches", { href: branches, size: "sm", variant: "ghost" })}
              ${btn(withCrew ? "Migrate with the crew" : "Migrate", {
                size: "sm",
                variant: "outline",
                type: "submit",
                name: "pick",
                value,
              })}`,
            });
          })}
        </ul>
        ${rows.length > shown.length
          ? html`<p class="muted small">
              ${rows.length - shown.length} more — filter to narrow.
            </p>`
          : null}`;
    })}
    ${branches === undefined ? null : branchList(branches)}
    <span class="hint"
      >Cloned with your account's credential, so private repositories come
      too — with their issues, comments, labels and open pull requests.</span
    >
  </div>`;
}

/** `<origin id>/<owner>/<name>` — an id never holds a slash, so the first one splits. */
const pickValue = (originId: string, fullName: string): string =>
  `${originId}/${fullName}`;

function parsePick(value: string): MigrateSource | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  return { originId: value.slice(0, slash), fullName: value.slice(slash + 1) };
}

function migrateForm(
  ctx: Ctx,
  values: MigrateValues,
  origins: readonly OriginChoices[],
  branches: BranchChoices | undefined,
  error?: string,
  unmatched: readonly string[] = [],
  refused: readonly string[] = [],
): Html {
  const user = ctx.auth.user!;
  const writeOrgs = listOrgsForUser(ctx.app.db, user.id).filter((org) =>
    accessAllows(orgAccess(ctx.app.db, org.id, user), "write"),
  );
  const owners = [user.username, ...writeOrgs.map((o) => o.username)];
  const agents = listAllAgents(ctx.app, user);
  const crew = agents.ok ? migrationBuilders(agents.value) : [];

  return html`<div class="narrow-wide">
    ${pageHead("Migrate a repository", {
      sub: "A one-time clone of the whole history — every branch, every tag — into a repository that lives here from now on. Nothing is written back to where it came from.",
    })}
    ${ctx.url.searchParams.get("connected") === "1"
      ? html`<p class="muted small mb" id="migrate-connected">
          ${icon("check")} Connected. Pick a repository below — one click
          migrates it.
        </p>`
      : null}
    ${unmatched.length === 0
      ? null
      : html`<p class="muted small mb" id="prefill-unmatched">
          ${icon("globe")} Ignored, nothing here matches:
          ${unmatched.join(", ")}
        </p>`}
    ${refused.length === 0
      ? null
      : html`<p class="muted small mb" id="prefill-refused">
          ${icon("globe")} ${refused.join(" ")}
        </p>`}
    ${accounts(ctx, origins)}
    <form method="get" action="/migrate" id="migrate-search"></form>
    <form method="post" action="/migrate">
        <h2 class="mb">Source</h2>
        ${picker(origins, values, crew.length > 0, branches)}
        ${formField({
          label: origins.every((o) => o.repos.length === 0)
            ? "Repository URL"
            : "Or a URL",
          name: "url",
          value: values.url,
          placeholder: "https://github.com/owner/name",
          autocomplete: "off",
          mono: true,
          autofocus: origins.every((o) => o.repos.length === 0),
          hint: "Any public repository over https, http or git. It is cloned anonymously.",
        })}
        <h2 class="mb mt">Destination</h2>
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
          hint: "Left blank, it keeps the source's name.",
          ...(error ? { error } : {}),
        })}
        ${selectField({
          label: "Visibility",
          name: "visibility",
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
        <h2 class="mb mt">Put a crew on it</h2>
        ${crew.length === 0
          ? html`<p class="muted small mb">
              ${icon("bot")} No agents on this forge yet, so there is no crew to
              hand the migration to.
              ${user.isAdmin
                ? html`Create one under
                    <a href="/settings/crew">Settings → Crew</a>.`
                : html`An admin can create one under account settings → Crew.`}
            </p>`
          : html`${selectField({
                label: "Agent",
                name: "agent",
                hint: "Joins the crew, makes the repository an app, and is told to make it run here — adapting it, not rewriting it.",
                options: [
                  {
                    value: "",
                    label: "Nobody — just the repository",
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
              <div class="field">
                <label class="check">
                  <input
                    type="checkbox"
                    name="autonomous"
                    ${values.autonomous ? raw("checked") : null}
                  />
                  <span
                    >Autonomous — green ships on its own. Off, every green
                    change waits for your look.</span
                  >
                </label>
              </div>`}
        <h2 class="mb mt">What happens to the GitHub repository</h2>
        ${selectField({
          label: "Afterwards",
          name: "after",
          hint: "Applies to a repository picked from a connected origin. Archiving needs admin rights there; without them the migration still succeeds and says so.",
          options: [
            {
              value: "leave",
              label: "Leave it alone",
              selected: values.after === "leave",
            },
            {
              value: "archive",
              label: "Archive it on the origin",
              selected: values.after === "archive",
            },
            {
              value: "mirror",
              label: "Keep it as a read-only mirror this forge pushes to",
              selected: values.after === "mirror",
            },
          ],
        })}
        <div class="form-actions">
          ${btn("Migrate", { variant: "primary", icon: "download" })}
          ${btn("Cancel", { href: "/", variant: "ghost" })}
        </div>
      </form>
  </div>`;
}

/**
 * The name field follows the picked repository or the pasted URL until
 * somebody types in it — a preview; the server names it the same way.
 */
export const migrateJs = /* js */ `
(function () {
  var name = document.getElementById('f-name');
  var url = document.getElementById('f-url');
  var q = document.getElementById('f-q');
  if (q) q.addEventListener('input', function () {
    var needle = q.value.trim().toLowerCase();
    var rows = document.querySelectorAll('[data-pick-rows] [data-q]');
    for (var i = 0; i < rows.length; i++)
      rows[i].hidden = needle !== '' && rows[i].getAttribute('data-q').indexOf(needle) < 0;
  });
  if (!name) return;
  var touched = name.value.trim() !== '';
  name.addEventListener('input', function () { touched = true; });
  function fromUrl(v) {
    var path = v.trim().replace(/[?#].*$/, '').replace(/\\/+$/, '');
    return (path.split('/').pop() || '').replace(/\\.git$/i, '');
  }
  function follow() {
    if (touched) return;
    name.value = url ? fromUrl(url.value) : '';
  }
  if (url) url.addEventListener('input', follow);
})();
`;

async function show(
  ctx: Ctx,
  values: MigrateValues,
  origins: readonly OriginChoices[],
  error?: string,
  status = 200,
  unmatched: readonly string[] = [],
  refused: readonly string[] = [],
): Promise<Response> {
  // Asked for only: each draw is a listing and a commit per branch at the
  // origin (remembered a minute), so a plain visit costs none of it.
  const branches = values.showBranches
    ? await timePhaseAsync(ctx.request, "branches", () =>
        branchChoices(ctx, origins, values.source, values.branch),
      )
    : undefined;
  const rendering = performance.now();
  const response = page(
    {
      ctx,
      title: "Migrate",
      body: migrateForm(ctx, values, origins, branches, error, unmatched, refused),
      scriptJs: migrateJs,
    },
    status,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /migrate
export async function migratePage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const q = ctx.url.searchParams;
  const origins = await timePhaseAsync(ctx.request, "origins", () =>
    originChoices(ctx),
  );
  const user = ctx.auth.user;
  const agents = timePhase(ctx.request, "agents", () =>
    listAllAgents(ctx.app, user),
  );
  const all = agents.ok ? agents.value : [];
  const builders = migrationBuilders(all);
  const names = builders.map((a) => a.user.username);
  const linked = prefill(
    { from: q.get("from"), crew: q.get("crew") },
    origins,
    names,
    all.filter((a) => !builders.includes(a)).map((a) => a.user.username),
  );
  return show(
    ctx,
    {
      source: linked.repo
        ? pickValue(linked.repo.originId, linked.repo.fullName)
        : (q.get("source") ?? ""),
      q: (q.get("q") ?? "").slice(0, 100),
      url: q.get("url") ?? "",
      owner: q.get("owner") ?? ctx.auth.user.username,
      name: q.get("name") ?? (linked.repo?.fullName.split("/").pop() ?? ""),
      visibility: "private",
      // One click on a row is "with the crew": the first agent is ready
      // unless the link named one; "Nobody" is one choice away.
      agent: linked.agent ?? names[0] ?? "",
      autonomous: false,
      after: "leave",
      branch: (q.get("branch") ?? "").slice(0, 300),
      showBranches: q.get("branches") === "1" || (q.get("branch") ?? "") !== "",
    },
    origins,
    undefined,
    200,
    linked.unmatched,
    linked.refused,
  );
}

// POST /migrate
export async function migrateSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const values: MigrateValues = {
    // A row's button names its repository; it wins over a prefilled pick.
    source: field(form, "pick") || field(form, "source"),
    q: "",
    url: field(form, "url").trim(),
    owner: field(form, "owner"),
    name: field(form, "name").trim(),
    visibility: field(form, "visibility") === "public" ? "public" : "private",
    agent: field(form, "agent"),
    autonomous: field(form, "autonomous") !== "",
    after: afterChoice(field(form, "after")),
    // A branch belongs to the repository its list was drawn for: another
    // row's button migrates that row by the rule, not by this choice.
    branch:
      field(form, "pick") === "" || field(form, "pick") === field(form, "source")
        ? field(form, "branch").trim()
        : "",
    showBranches: false,
  };
  values.showBranches = values.branch !== "";
  const again = async (message: string): Promise<Response> =>
    show(ctx, values, await originChoices(ctx), message, 422);

  const picked = values.source === "" ? undefined : parsePick(values.source);
  if (picked !== undefined && values.url !== "")
    return again(
      "Pick a repository or paste a URL, not both — clear one of them.",
    );
  if (picked === undefined && values.url === "")
    return again("Pick a repository from an origin, or paste its URL.");
  // Cloning through an origin spends that account's credential on another
  // forge — the same `admin` floor every origin route keeps for a token.
  if (
    picked !== undefined &&
    (ctx.auth.scope === undefined || !scopeAllows(ctx.auth.scope, "admin"))
  )
    return forbiddenPage(ctx, "This token is not allowed to do this.");

  const started = await migrateRepo(ctx.app, ctx.auth.user, {
    source: picked ?? { url: values.url },
    owner: values.owner,
    name: values.name,
    visibility: values.visibility === "public" ? "public" : "private",
    ...(picked === undefined || values.branch === ""
      ? {}
      : { branch: values.branch }),
    ...(values.agent === ""
      ? {}
      : { crew: { agent: values.agent, autonomous: values.autonomous } }),
    after: values.after,
  });
  if (!started.ok) {
    if (started.error === "forbidden_owner" || started.error === "unauthorized")
      return forbiddenPage(ctx, NOT_YOURS_TO_DO);
    return again(
      migrateMessage(started.error, repositoryLimitMessage(ctx.app, ctx.auth.user!)),
    );
  }
  return redirect(`/migrate/jobs/${started.value.job.id}`);
}

const STAGES: { name: MirrorStage; label: string }[] = [
  { name: "creating", label: "Creating the repository" },
  { name: "fetching", label: "Cloning every branch and tag" },
  { name: "issues", label: "Bringing issues, comments and labels" },
  { name: "pulls", label: "Bringing open pull requests and their branches" },
  { name: "crew", label: "Making it an app and starting the crew's first run" },
  { name: "done", label: "Done" },
];

/** A pasted URL brings history alone: no conversation rows to wait on. */
const stagesFor = (job: MirrorJob): typeof STAGES =>
  job.originId === ""
    ? STAGES.filter((s) => s.name !== "issues" && s.name !== "pulls")
    : STAGES;

function stageRows(job: MirrorJob): Html {
  const stages = stagesFor(job);
  return html`<ol class="list stages" aria-live="polite">
    ${stages.map((stage) => {
      const state = stageStateFor(
        stages.map((s) => s.name),
        stage.name,
        job.stage,
        job.failedAt,
      );
      return stageRow({
        name: stage.name,
        label: stage.label,
        state,
        detail: job.detail,
      });
    })}
  </ol>`;
}

/**
 * The job's page follows its stages over the job's own event stream
 * (`/api/v1/migrate/:job/stream`, the same owner check as the page) and
 * patches the rows in place. A terminal stage reloads the page, which is
 * then the repository (done, with the flash) or the failure that stands
 * with its reason. Without a script, a plain Reload link.
 */
const migrateJobJs = /* js */ `
(function () {
  var box = document.getElementById('migrate-job');
  var job = box && box.getAttribute('data-job');
  if (!job || typeof EventSource === 'undefined') return;
  var order = ['creating', 'fetching', 'issues', 'pulls', 'crew', 'done'];
  var badges = ${STAGE_BADGE_JS};
  var source = new EventSource('/api/v1/migrate/' + encodeURIComponent(job) + '/stream');
  function patch(e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    var at = order.indexOf(data.stage);
    var rows = box.querySelectorAll('[data-stage-name]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var idx = order.indexOf(row.getAttribute('data-stage-name'));
      var state = data.stage === 'failed' ? 'todo'
        : data.stage === 'done' || idx < at ? 'done' : idx === at ? 'now' : 'todo';
      row.setAttribute('data-state', state);
      var badge = row.querySelector('.badge');
      badge.textContent = badges[state][0];
      badge.setAttribute('data-variant', badges[state][1]);
      var note = row.querySelector('.row-meta');
      if (note) note.textContent = state === 'now' && data.detail ? data.detail : '';
    }
    if (data.stage === 'done' || data.stage === 'failed') { source.close(); location.reload(); }
  }
  ['creating', 'fetching', 'labels', 'issues', 'pulls', 'comments', 'crew', 'done', 'failed']
    .forEach(function (stage) { source.addEventListener('migrate.' + stage, patch); });
})();
`;

export function migrationJobPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const user = ctx.auth.user;
  const found = timePhase(ctx.request, "job", () =>
    migrationJobFor(user, ctx.params.job ?? ""),
  );
  if (!found.ok) return notFoundPage(ctx);
  const job = found.value;
  if (job.stage === "done" && job.repo !== undefined)
    return flashTo(ctx, `/${job.repo.ownerName}/${job.repo.name}`, {
      message: `${capitalise(job.detail)}.`,
    });
  const failed = job.stage === "failed";
  const rendering = performance.now();
  const response = page({
    ctx,
    title: `Migrating ${job.fullName}`,
    ...(failed ? {} : { scriptJs: migrateJobJs }),
    body: html`${pageHead(`Migrating ${job.fullName}`)}
      <div class="narrow-wide" id="migrate-job" data-job="${job.id}">
        <h2 class="mb">${job.fullName}</h2>
        ${stageRows(job)}
        ${failed
          ? html`<div class="field" data-invalid>
                <span class="error" role="alert" id="migrate-job-err"
                  >${job.error ?? "The migration failed."}</span
                >
              </div>
              <div class="bar mt">
                ${btn("Try again", {
                  href: `/migrate?${new URLSearchParams(
                    job.originId === ""
                      ? { url: job.fullName }
                      : { source: pickValue(job.originId, job.fullName) },
                  )}`,
                  variant: "primary",
                  icon: "sync",
                })}
              </div>`
          : html`<p class="muted small mt">
              This keeps going if you close the page — come back to this link
              and it will say where it got to.
              <noscript><a href="">Reload</a> to see the latest.</noscript>
            </p>`}
      </div>`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const capitalise = (s: string): string =>
  s === "" ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`;
