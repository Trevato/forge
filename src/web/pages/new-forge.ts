/**
 * `/forges/new`: "+ New forge" (#426), the page a signed-in person spawns a
 * child from (they claim it and become its admin). It is the same door as `POST /api/v1/forges` and the MCP
 * `spawn` (`spawn/door.ts`), as one form that works without JavaScript.
 *
 * The path: the owner wants to send someone a forge; from the "+" menu he
 * fills in a name and ticks the apps, presses **See the plan** (nothing is
 * made), then **Spawn**, and copies the one link to send. The claim link is
 * shown once, in the answer's body — never in a URL, never cached.
 */

import { listAgents } from "../../core/agents.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { quotaFull } from "../../spawn/quota.ts";
import { childHost, childUrlOf, noRoom, spawnDoor, type Door } from "../../spawn/door.ts";
import {
  LEFT_BEHIND,
  MAX_FOR_CHARS,
  MAX_FRESH_CHARS,
  MAX_BUDGET_USD,
  MIN_BUDGET_USD,
} from "../../spawn/plan.ts";
import { DEFAULT_SIZE, SIZES, sizesView } from "../../spawn/sizes.ts";
import { DEFAULT_TEMPLATE, TEMPLATES, templateOf } from "../../spawn/templates.ts";
import { FOLLOW_LABELS, FOLLOW_WORDS } from "../../spawn/follow_words.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { pickList } from "../pick.ts";
import { btn, card, field as formField, row, selectField } from "../ui.ts";

interface Values {
  readonly name: string;
  readonly forWhom: string;
  readonly direction: string;
  readonly apps: readonly string[];
  readonly crew: readonly string[];
  readonly fresh: string;
  readonly followMode: string;
  readonly keepAccess: boolean;
  readonly budgetUsd: string;
  readonly modelEndpoint: string;
  readonly size: string;
  readonly template: string;
  /** The last post carried a key: it is never sent back, so it is asked for again. */
  readonly hadKey: boolean;
}

const EMPTY: Values = {
  name: "",
  forWhom: "",
  direction: "",
  apps: [],
  crew: [],
  fresh: "",
  followMode: "tell-me",
  keepAccess: false,
  budgetUsd: "",
  modelEndpoint: "",
  size: DEFAULT_SIZE,
  template: DEFAULT_TEMPLATE,
  hadKey: false,
};

type Errors = Partial<Record<string, string>>;

const all = (form: Form, name: string): string[] =>
  form
    .getAll(name)
    .filter((v): v is string => typeof v === "string" && v !== "");

/** The door's refusal, beside the field it names: "name: must be …". */
function errorsOf(door: Door): Errors {
  const message = String(door.body["message"] ?? "");
  const m = /^([A-Za-z]+): (.*)$/.exec(message);
  if (door.body["error"] === "invalid" && m) return { [m[1]!]: m[2]! };
  return { form: message };
}

/** What the form reads before it draws: room, then (when there is room) the repositories and the crew. */
interface Reads {
  readonly full: string | undefined;
  /** Why even a small forge would pass the host's child quota; the form still draws. */
  readonly quota: string | undefined;
  readonly repos: ReturnType<typeof listReposVisibleTo>;
  readonly crew: ReturnType<typeof listAgents>;
}

function readsFor(ctx: Ctx, user: User | undefined): Reads {
  const full = timePhase(ctx.request, "room", () => noRoom(ctx.app));
  if (full) return { full, quota: undefined, repos: [], crew: [] };
  const quota = quotaFull(ctx.app.config.dataDir);
  // A stranger sees only public repositories, and no crew: nothing private
  // travels to a child they have not claimed.
  const repos = timePhase(ctx.request, "repos", () =>
    listReposVisibleTo(ctx.app.db, user, { limit: 200 }),
  );
  const crew =
    user === undefined
      ? []
      : timePhase(ctx.request, "crew", () => listAgents(ctx.app.db));
  return { full, quota, repos, crew };
}

/** The three sizes, the one asked for chosen (small when the value is not one of them). */
const lower = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

function sizeOptions(chosen: string): { value: string; label: string; selected?: boolean }[] {
  const says = new Map(sizesView().sizes.map((s) => [s.size, s.says]));
  const at = Object.hasOwn(SIZES, chosen) ? chosen : DEFAULT_SIZE;
  return Object.keys(SIZES).map((size) => ({
    value: size,
    label: `${size}: ${lower(says.get(size as keyof typeof SIZES) ?? "")}`,
    selected: size === at,
  }));
}

/** The templates in order, Blank first; the one asked for chosen (Blank when it is not one of them). */
function templateOptions(chosen: string): { value: string; label: string; selected?: boolean }[] {
  const at = TEMPLATES.some((t) => t.id === chosen) ? chosen : DEFAULT_TEMPLATE;
  return TEMPLATES.map((t) => ({
    value: t.id,
    label: `${t.title}: ${lower(t.says)}`,
    selected: t.id === at,
  }));
}

function formView(
  ctx: Ctx,
  user: User | undefined,
  values: Values,
  errors: Errors,
  plan: Html | null,
  reads: Reads,
): Html {
  const { full, quota, repos, crew } = reads;
  if (full)
    return html`<div class="narrow-wide">
      ${pageHead("New forge")}
      ${card(
        html`<p role="status">This forge cannot hold another child: ${full}.</p>
          ${ctx.auth.user?.isAdmin
            ? html`<p><a href="/settings/capacity">Raise the room in settings</a></p>`
            : null}`,
      )}
    </div>`;
  const anon = user === undefined;
  return html`<div class="narrow-wide">
    ${pageHead("New forge", {
      sub: anon
        ? "Your own forge: pick a name, and the public apps to start from. Whoever opens the claim link becomes its admin."
        : "Your own forge, or one for someone else: the apps you choose, a crew, and one link to claim.",
      actions: btn("Forges you sent", { href: "/forges", size: "sm" }),
    })}
    <p class="muted small" id="hosting-terms">Free within limits while hosting is not sold: a few forges per person, and a forge sleeps when idle and wakes on its next visit. Its crew stays off until you bring your own model credential.</p>
    ${quota ? html`<p role="status" id="quota-full">This forge cannot hold another child: ${quota}.</p>` : null}
    ${errors["form"]
      ? html`<p class="error mb" role="alert">${errors["form"]}</p>`
      : null}
    ${plan}
    ${card(
      html`<form method="post" action="/forges/new" class="stack" id="new-forge">
        ${formField({
          label: "Name",
          name: "name",
          value: values.name,
          required: true,
          autofocus: true,
          hint: `Its address: <name>--${childHost(ctx.app)}. Lowercase letters, digits and dashes.`,
          ...(errors["name"] ? { error: errors["name"] } : {}),
        })}
        ${anon
          ? null
          : formField({
              label: "For whom",
              name: "for",
              value: values.forWhom,
              hint: `A person, a client or an organisation, for your list of forges sent (at most ${MAX_FOR_CHARS} characters). Never copied into the child.`,
              ...(errors["for"] ? { error: errors["for"] } : {}),
            })}
        ${formField({
          label: "What it is for",
          name: "direction",
          type: "textarea",
          rows: 3,
          value: values.direction,
          hint: "In your words: the crew's first direction. Optional.",
          ...(errors["direction"] ? { error: errors["direction"] } : {}),
        })}
        ${pickList({
          legend: "Apps to fork, with their history",
          name: "apps",
          noun: "repositories",
          items: repos.map((r) => ({
            value: `${r.ownerName}/${r.name}`,
            label: `${r.ownerName}/${r.name}`,
          })),
          chosen: values.apps,
          error: errors["apps"],
        })}
        ${formField({
          label: "Or a fresh app (optional)",
          name: "fresh",
          value: values.fresh,
          hint: `One line on what it is; the child gets a small app to start from (at most ${MAX_FRESH_CHARS} characters).`,
          ...(errors["fresh"] ? { error: errors["fresh"] } : {}),
        })}
        <fieldset class="field" ${errors["followMode"] ? html`data-invalid` : null}>
          <legend>How it follows this forge's code</legend>
          <label class="check">
            <input
              type="radio"
              name="followMode"
              value="tell-me"
              ${values.followMode !== "take-updates" ? html`checked` : null}
            />
            <span
              >${FOLLOW_LABELS["tell-me"]} <span class="muted small">${FOLLOW_WORDS["tell-me"]}</span></span
            >
          </label>
          <label class="check">
            <input
              type="radio"
              name="followMode"
              value="take-updates"
              ${values.followMode === "take-updates" ? html`checked` : null}
            />
            <span
              >${FOLLOW_LABELS["take-updates"]} <span class="muted small">${FOLLOW_WORDS["take-updates"]}</span></span
            >
          </label>
          ${errors["followMode"]
            ? html`<span class="error" id="f-followMode-err">${errors["followMode"]}</span>`
            : null}
        </fieldset>
        ${crew.length === 0
          ? null
          : pickList({
              legend: "Crew whose briefs go along",
              name: "crew",
              noun: "crew",
              items: crew.map((a) => ({ value: a.user.username, label: a.user.username })),
              chosen: values.crew,
              error: errors["crew"],
            })}
        ${anon
          ? null
          : html`<fieldset class="field">
              <legend>After it is claimed</legend>
              <label class="check">
                <input
                  type="checkbox"
                  name="keepAccess"
                  ${values.keepAccess ? html`checked` : null}
                />
                <span>Keep your owner access (the claim page tells them)</span>
              </label>
            </fieldset>`}
        ${anon
          ? null
          : formField({
              label: values.hadKey ? "Model key" : "Model key (optional)",
              name: "modelKey",
              type: "password",
              autocomplete: "off",
              required: values.hadKey,
              hint: values.hadKey
                ? "Type the key again to spawn: it is never sent back to your browser."
                : "An Anthropic key (sk-ant-api…, sk-ant-usr…), a `claude setup-token` token (sk-ant-oat…), or any gateway's key with its base URL below; with its own spend limit, sealed in the child, never shown again.",
              ...(errors["modelKey"] ? { error: errors["modelKey"] } : {}),
            })}
        ${anon
          ? null
          : formField({
              label: "API base URL (optional)",
              name: "modelEndpoint",
              type: "url",
              value: values.modelEndpoint,
              hint: "Anthropic-compatible gateway for the key. OpenRouter: https://openrouter.ai/api. Leave empty for Anthropic.",
              ...(errors["modelEndpoint"] ? { error: errors["modelEndpoint"] } : {}),
            })}
        ${anon
          ? null
          : formField({
              label: `Its budget, in dollars (${MIN_BUDGET_USD}–${MAX_BUDGET_USD})`,
              name: "budgetUsd",
              type: "number",
              value: values.budgetUsd,
              hint: "For the key's whole life; the child cannot raise it. Needed with a key.",
              ...(errors["budgetUsd"] ? { error: errors["budgetUsd"] } : {}),
            })}
        ${selectField({
          label: "Template",
          name: "template",
          hint: "What the child starts from besides the apps you fork. Blank is the default.",
          options: templateOptions(values.template),
          ...(errors["template"] ? { error: errors["template"] } : {}),
        })}
        ${selectField({
          label: "Size (optional)",
          name: "size",
          hint: "Room for the child to grow into. Small is the default and is not recorded.",
          options: sizeOptions(values.size),
          ...(errors["size"] ? { error: errors["size"] } : {}),
        })}
        <p class="muted small">
          Never copied: ${LEFT_BEHIND.join(", ")}. The child mints its own.
        </p>
        <div class="form-actions">
          <button class="btn" type="submit" name="do" value="plan">
            See the plan
          </button>
          ${btn("Spawn", { variant: "primary" })}
        </div>
      </form>`,
    )}
  </div>`;
}

/**
 * The dry run, as the page shows it above the form: what the person gets
 * (where, as whom, with whom still there, on what budget), then what is
 * copied — and the Spawn it confirms, so a phone need not scroll back down.
 */
function planView(ctx: Ctx, user: User | undefined, values: Values, body: Record<string, unknown>): Html {
  const copied = (body["copied"] as string[] | undefined) ?? [];
  const bytes = Number(body["bytes"] ?? 0);
  const note = body["keyNote"];
  const plan = body["plan"] as { budgetUsd?: number | null; template?: string } | undefined;
  const budget = plan?.budgetUsd ?? null;
  const address = childUrlOf(ctx.app, values.name);
  return card(
    html`<ul class="mb">
        <li>A forge at <b>${address}</b>.</li>
        <li>Whoever opens the link becomes its admin.</li>
        ${user === undefined
          ? null
          : html`<li>
              ${values.keepAccess
                ? "You keep owner access after it is claimed; the claim page tells them."
                : "You leave once it is claimed; they can invite you back."}
            </li>`}
        ${plan?.template === undefined
          ? null
          : html`<li>It starts from the <b>${templateOf(plan.template).title}</b> template.</li>`}
        ${budget === null
          ? null
          : html`<li>Its crew runs on the key you give, up to $${budget} for the key's whole life.</li>`}
      </ul>
      <p class="mb">Copied into it:</p>
      <ul class="mb">
        ${copied.map((c) => html`<li>${c}</li>`)}
      </ul>
      <p class="muted small">
        About ${Math.max(1, Math.round(bytes / 1024))} KB. Nothing is made until
        you press Spawn.
      </p>
      ${typeof note === "string" ? html`<p class="small mt">${note}</p>` : null}
      <p class="mt">${btn("Spawn", { variant: "primary", form: "new-forge" })}</p>`,
    { id: "plan", head: html`<h2>The plan</h2>` },
  );
}

/** The answer to a spawn: the link, once. */
/** The claim link, shown once: what to do with it, and a way to copy it. */
export function claimLinkBody(link: string, note?: string): Html {
  return html`<p class="mb">
      Send this link to the person it is for. It works once, for a day, and
      is shown only now.
    </p>
    <p class="muted small mb">
      Send it as you would a password: to them alone, not to a group.
    </p>
    ${card(html`<ul class="list setting-list">${
      row({
        title: html`<code class="mono" id="claim-link">${link}</code>`,
        trail: btn("Copy the link", { type: "button", copy: "claim-link", icon: "copy", variant: "primary", size: "sm" }),
      })
    }</ul>`, { pad: false })}
    <p class="mt">${btn("Forges you sent", { href: "/forges", size: "sm" })}</p>
    ${note === undefined ? null : html`<p class="small mt">${note}</p>`}`;
}

function madeView(body: Record<string, unknown>): Html {
  const link = body["claimUrl"];
  const note = body["keyNote"];
  const name = String(body["name"] ?? "");
  return html`<div class="narrow-wide">
    ${pageHead(
      body["existed"] === true ? `${name} already exists` : `${name} is ready`,
    )}
    ${card(
      typeof link === "string"
        ? claimLinkBody(link, typeof note === "string" ? note : undefined)
        : html`<p>
            It was made before, so its link is not shown again. Ask for a new
            one if it was lost.
          </p>`,
    )}
  </div>`;
}

const asBool = (form: Form, name: string): boolean =>
  field(form, name) === "on";

// GET /forges/new — any signed-in person, or a stranger (agents are refused).
export function newForgePage(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (user && user.kind !== "user") return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const reads = readsFor(ctx, user);
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "New forge",
    body: formView(ctx, user, { ...EMPTY, name: (ctx.url.searchParams.get("name") ?? "").slice(0, 38) }, {}, null, reads),
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /forges/new — `do=plan` shows the plan; anything else spawns.
export async function newForgeSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user && user.kind !== "user") return notFoundPage(ctx);
  // A stranger posts without a token scope; the same-origin check still holds.
  const form = await readForm(ctx, user === undefined ? undefined : "admin");
  if (form instanceof Response) return form;
  const values: Values = {
    name: field(form, "name").trim(),
    forWhom: field(form, "for").trim(),
    direction: field(form, "direction"),
    apps: all(form, "apps"),
    crew: all(form, "crew"),
    fresh: field(form, "fresh").trim(),
    followMode: field(form, "followMode").trim() || "tell-me",
    keepAccess: asBool(form, "keepAccess"),
    budgetUsd: field(form, "budgetUsd").trim(),
    modelEndpoint: field(form, "modelEndpoint").trim(),
    size: field(form, "size").trim() || DEFAULT_SIZE,
    template: field(form, "template").trim() || DEFAULT_TEMPLATE,
    hadKey: field(form, "modelKey").trim() !== "",
  };
  const key = field(form, "modelKey").trim();
  const planOnly = field(form, "do") === "plan";
  const door = await spawnDoor(ctx, user, {
    name: values.name,
    apps: values.apps,
    crew: values.crew,
    keepAccess: values.keepAccess,
    ...(values.fresh === "" ? {} : { fresh: values.fresh }),
    followMode: values.followMode,
    ...(values.forWhom === "" ? {} : { for: values.forWhom }),
    ...(values.direction.trim() === "" ? {} : { direction: values.direction }),
    ...(key === "" ? {} : { modelKey: key }),
    ...(values.modelEndpoint === "" ? {} : { modelEndpoint: values.modelEndpoint }),
    ...(values.budgetUsd === "" ? {} : { budgetUsd: Number(values.budgetUsd) }),
    // Small is the default: it is not recorded, so the plan stays as it was.
    ...(values.size === DEFAULT_SIZE ? {} : { size: values.size }),
    ...(values.template === DEFAULT_TEMPLATE ? {} : { template: values.template }),
    dryRun: planOnly,
  });
  if (door.status >= 400)
    return page(
      {
        ctx,
        title: "New forge",
        body: formView(ctx, user, values, errorsOf(door), null, readsFor(ctx, user)),
      },
      door.status === 422 ? 422 : door.status,
    );
  if (planOnly)
    return page({
      ctx,
      title: "New forge",
      body: formView(ctx, user, values, {}, planView(ctx, user, values, door.body), readsFor(ctx, user)),
    });
  const response = page(
    { ctx, title: "New forge", body: madeView(door.body) },
    door.status,
  );
  // The link is in this body only: never kept by a cache.
  response.headers.set("cache-control", "no-store");
  return response;
}
