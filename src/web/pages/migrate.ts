/**
 * Migrate on the web: the form behind "+" → Migrate, and the page that
 * watches the clone. A repository comes from one of your origins or from a
 * pasted URL, lands under an owner and a name you choose, and — when you
 * put a crew on it — becomes an app the crew is already making run.
 *
 * Every mutation is `migrateRepo`; the page only puts its answer into words.
 */

import { repositoryLimitMessage } from "../../actions/repos.ts";
import { listAllAgents } from "../../actions/crew.ts";
import {
  migrateMessage,
  migrateRepo,
  migrationJobFor,
  type MigrateSource,
} from "../../actions/migrate.ts";
import { listRemoteRepos, listUserOrigins } from "../../actions/origins.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import type { OriginRepoRow } from "../../core/origins.ts";
import { scopeAllows } from "../../core/tokens.ts";
import type { Ctx } from "../../http/context.ts";
import type { MirrorJob, MirrorStage } from "../../origins/jobs.ts";
import { notFoundPage, pageHead, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, raw, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { btn, card, icon, selectField, field as formField } from "../ui.ts";
import { prefill, originHost } from "./migrate-prefill.ts";
import { hostLabel } from "./origins.ts";

interface MigrateValues {
  source: string;
  url: string;
  owner: string;
  name: string;
  visibility: string;
  agent: string;
  autonomous: boolean;
}

/** An origin's repositories, for the picker; an origin that cannot answer is left out. */
interface OriginChoices {
  readonly label: string;
  readonly id: string;
  readonly host: string;
  readonly repos: readonly OriginRepoRow[];
}

async function originChoices(ctx: Ctx): Promise<OriginChoices[]> {
  const user = ctx.auth.user!;
  const out: OriginChoices[] = [];
  for (const origin of listUserOrigins(ctx.app, user)) {
    const listed = await listRemoteRepos(ctx.app, user, origin.id);
    if (!listed.ok || listed.value.length === 0) continue;
    out.push({
      id: origin.id,
      host: originHost(origin.webUrl),
      label: `${origin.login} @ ${hostLabel(origin.webUrl)}`,
      repos: listed.value,
    });
  }
  return out;
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
  error?: string,
  unmatched: readonly string[] = [],
): Html {
  const user = ctx.auth.user!;
  const writeOrgs = listOrgsForUser(ctx.app.db, user.id).filter((org) =>
    accessAllows(orgAccess(ctx.app.db, org.id, user), "write"),
  );
  const owners = [user.username, ...writeOrgs.map((o) => o.username)];
  const agents = listAllAgents(ctx.app, user);
  const crew = agents.ok ? agents.value : [];

  const picker =
    origins.length === 0
      ? html`<p class="muted small mb">
          ${icon("globe")} Connect an origin under
          <a href="/settings/origins">Settings → Origins</a> to pick from your
          repositories there, private ones included.
        </p>`
      : html`<div class="field">
          <label for="f-source">From one of your origins</label>
          <select class="input" id="f-source" name="source">
            <option value="" ${values.source === "" ? raw("selected") : null}>
              — none, I'll paste a URL —
            </option>
            ${origins.map(
              (origin) =>
                html`<optgroup label="${origin.label}">
                  ${origin.repos.map((remote) => {
                    const value = pickValue(origin.id, remote.fullName);
                    return html`<option
                      value="${value}"
                      data-name="${remote.fullName.split("/").pop() ?? ""}"
                      ${values.source === value ? raw("selected") : null}
                    >
                      ${remote.fullName}${remote.private ? " (private)" : ""}
                    </option>`;
                  })}
                </optgroup>`,
            )}
          </select>
          <span class="hint"
            >Cloned with your origin's credential, so private repositories come
            too.</span
          >
        </div>`;

  return html`<div class="narrow-wide">
    ${pageHead("Migrate a repository", {
      sub: "A one-time clone of the whole history — every branch, every tag — into a repository that lives here from now on. Nothing is written back to where it came from.",
    })}
    ${unmatched.length === 0
      ? null
      : html`<p class="muted small mb" id="prefill-unmatched">
          ${icon("globe")} Ignored, nothing here matches:
          ${unmatched.join(", ")}
        </p>`}
    ${card(
      html`<form method="post" action="/migrate">
        <h3 class="mb">Source</h3>
        ${picker}
        ${formField({
          label: origins.length === 0 ? "Repository URL" : "Or a URL",
          name: "url",
          value: values.url,
          placeholder: "https://github.com/owner/name",
          autocomplete: "off",
          mono: true,
          autofocus: origins.length === 0,
          hint: "Any public repository over https, http or git. It is cloned anonymously.",
        })}
        <h3 class="mb mt">Destination</h3>
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
        <h3 class="mb mt">Put a crew on it</h3>
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
        <div class="form-actions">
          ${btn("Migrate", { variant: "primary", icon: "download" })}
          ${btn("Cancel", { href: "/", variant: "ghost" })}
        </div>
      </form>`,
    )}
  </div>`;
}

/**
 * The name field follows the picked repository or the pasted URL until
 * somebody types in it — a preview; the server names it the same way.
 */
const migrateJs = /* js */ `
(function () {
  var name = document.getElementById('f-name');
  var url = document.getElementById('f-url');
  var source = document.getElementById('f-source');
  if (!name) return;
  var touched = name.value.trim() !== '';
  name.addEventListener('input', function () { touched = true; });
  function fromUrl(v) {
    var path = v.trim().replace(/[?#].*$/, '').replace(/\\/+$/, '');
    return (path.split('/').pop() || '').replace(/\\.git$/i, '');
  }
  function follow() {
    if (touched) return;
    var picked = source && source.selectedIndex > 0
      ? source.options[source.selectedIndex].getAttribute('data-name') || ''
      : '';
    name.value = picked !== '' ? picked : url ? fromUrl(url.value) : '';
  }
  if (url) url.addEventListener('input', follow);
  if (source) source.addEventListener('change', follow);
})();
`;

function show(
  ctx: Ctx,
  values: MigrateValues,
  origins: readonly OriginChoices[],
  error?: string,
  status = 200,
  unmatched: readonly string[] = [],
): Response {
  return page(
    {
      ctx,
      title: "Migrate",
      body: migrateForm(ctx, values, origins, error, unmatched),
      scriptJs: migrateJs,
    },
    status,
  );
}

// GET /migrate
export async function migratePage(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const q = ctx.url.searchParams;
  const origins = await originChoices(ctx);
  const agents = listAllAgents(ctx.app, ctx.auth.user);
  const linked = prefill(
    { from: q.get("from"), crew: q.get("crew") },
    origins,
    agents.ok ? agents.value.map((a) => a.user.username) : [],
  );
  return show(
    ctx,
    {
      source: linked.repo
        ? pickValue(linked.repo.originId, linked.repo.fullName)
        : (q.get("source") ?? ""),
      url: q.get("url") ?? "",
      owner: q.get("owner") ?? ctx.auth.user.username,
      name: q.get("name") ?? (linked.repo?.fullName.split("/").pop() ?? ""),
      visibility: "private",
      agent: linked.agent ?? "",
      autonomous: false,
    },
    origins,
    undefined,
    200,
    linked.unmatched,
  );
}

// POST /migrate
export async function migrateSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const values: MigrateValues = {
    source: field(form, "source"),
    url: field(form, "url").trim(),
    owner: field(form, "owner"),
    name: field(form, "name").trim(),
    visibility: field(form, "visibility") === "public" ? "public" : "private",
    agent: field(form, "agent"),
    autonomous: field(form, "autonomous") !== "",
  };
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
    return new Response("forbidden", { status: 403 });

  const started = await migrateRepo(ctx.app, ctx.auth.user, {
    source: picked ?? { url: values.url },
    owner: values.owner,
    name: values.name,
    visibility: values.visibility === "public" ? "public" : "private",
    ...(values.agent === ""
      ? {}
      : { crew: { agent: values.agent, autonomous: values.autonomous } }),
  });
  if (!started.ok) {
    if (started.error === "forbidden_owner" || started.error === "unauthorized")
      return new Response("forbidden", { status: 403 });
    return again(
      migrateMessage(started.error, repositoryLimitMessage(ctx.app, ctx.auth.user!)),
    );
  }
  return redirect(`/migrate/jobs/${started.value.job.id}`);
}

const STAGES: { name: MirrorStage; label: string }[] = [
  { name: "creating", label: "Creating the repository" },
  { name: "fetching", label: "Cloning every branch and tag" },
  { name: "crew", label: "Putting the crew on it" },
  { name: "done", label: "Done" },
];

function stageRows(job: MirrorJob): Html {
  const at = STAGES.findIndex((s) => s.name === job.stage);
  return html`<ol class="stages">
    ${STAGES.map((stage, i) => {
      const state =
        job.stage === "failed"
          ? "todo"
          : i < at || job.stage === "done"
            ? "done"
            : i === at
              ? "now"
              : "todo";
      const glyph = state === "done" ? "●" : state === "now" ? "◐" : "○";
      return html`<li data-stage-name="${stage.name}" data-state="${state}">
        <span class="stage-dot" aria-hidden="true">${glyph}</span>
        <span class="stage-label">${stage.label}</span>
        <span class="stage-detail">${state === "now" ? job.detail : ""}</span>
      </li>`;
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
  var order = ['creating', 'fetching', 'crew', 'done'];
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
      row.querySelector('.stage-dot').textContent = state === 'done' ? '\\u25cf' : state === 'now' ? '\\u25d0' : '\\u25cb';
      row.querySelector('.stage-detail').textContent = state === 'now' && data.detail ? data.detail : '';
    }
    if (data.stage === 'done' || data.stage === 'failed') { source.close(); location.reload(); }
  }
  ['creating', 'fetching', 'labels', 'issues', 'pulls', 'comments', 'crew', 'done', 'failed']
    .forEach(function (stage) { source.addEventListener('migrate.' + stage, patch); });
})();
`;

export function migrationJobPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const found = migrationJobFor(ctx.auth.user, ctx.params.job ?? "");
  if (!found.ok) return notFoundPage(ctx);
  const job = found.value;
  if (job.stage === "done" && job.repo !== undefined)
    return flashTo(ctx, `/${job.repo.ownerName}/${job.repo.name}`, {
      message: `${capitalise(job.detail)}.`,
    });
  const failed = job.stage === "failed";
  return page({
    ctx,
    title: `Migrating ${job.fullName}`,
    ...(failed ? {} : { scriptJs: migrateJobJs }),
    body: html`${pageHead(`Migrating ${job.fullName}`)}
      <div class="narrow-wide" id="migrate-job" data-job="${job.id}">
        ${card(stageRows(job), {
          head: html`${icon("download")}
            <h2>${job.fullName}</h2>`,
        })}
        ${failed
          ? html`<p class="error-note">
                ${job.error ?? "The migration failed."}
              </p>
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
}

const capitalise = (s: string): string =>
  s === "" ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`;
