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
import { childHost, childUrlOf, noRoom, spawnDoor, type Door } from "../../spawn/door.ts";
import {
  LEFT_BEHIND,
  MAX_FOR_CHARS,
  MAX_FRESH_CHARS,
  MAX_BUDGET_USD,
  MIN_BUDGET_USD,
} from "../../spawn/plan.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, field as formField } from "../ui.ts";

interface Values {
  readonly name: string;
  readonly forWhom: string;
  readonly direction: string;
  readonly apps: readonly string[];
  readonly crew: readonly string[];
  readonly fresh: string;
  readonly keepAccess: boolean;
  readonly budgetUsd: string;
  readonly modelEndpoint: string;
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
  keepAccess: false,
  budgetUsd: "",
  modelEndpoint: "",
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

function checks(
  name: string,
  items: readonly { value: string; label: string; note?: string }[],
  chosen: readonly string[],
): Html {
  return html`${items.map(
    (i) =>
      html`<label class="check">
        <input
          type="checkbox"
          name="${name}"
          value="${i.value}"
          ${chosen.includes(i.value) ? html`checked` : null}
        />
        <span
          >${i.label}${i.note
            ? html` <span class="muted small">${i.note}</span>`
            : null}</span
        >
      </label>`,
  )}`;
}

function formView(
  ctx: Ctx,
  user: User | undefined,
  values: Values,
  errors: Errors,
  plan: Html | null,
): Html {
  const full = noRoom(ctx.app);
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
  // A stranger sees only public repositories, and no crew: nothing private
  // travels to a child they have not claimed.
  const anon = user === undefined;
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  const crew = anon ? [] : listAgents(ctx.app.db);
  return html`<div class="narrow-wide">
    ${pageHead("New forge", {
      sub: anon
        ? "Your own forge: pick a name, and the public apps to start from. Whoever opens the claim link becomes its admin."
        : "Your own forge, or one for someone else: the apps you choose, a crew, and one link to claim.",
      actions: btn("Forges you sent", { href: "/forges", size: "sm" }),
    })}
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
        <fieldset class="field" ${errors["apps"] ? html`data-invalid` : null}>
          <legend>Apps to fork, with their history</legend>
          ${checks(
            "apps",
            repos.map((r) => ({
              value: `${r.ownerName}/${r.name}`,
              label: `${r.ownerName}/${r.name}`,
            })),
            values.apps,
          )}
          ${errors["apps"]
            ? html`<span class="error" id="f-apps-err">${errors["apps"]}</span>`
            : null}
        </fieldset>
        ${formField({
          label: "Or a fresh app (optional)",
          name: "fresh",
          value: values.fresh,
          hint: `One line on what it is; the child gets a small app to start from (at most ${MAX_FRESH_CHARS} characters).`,
          ...(errors["fresh"] ? { error: errors["fresh"] } : {}),
        })}
        ${crew.length === 0
          ? null
          : html`<fieldset class="field">
              <legend>Crew whose briefs go along</legend>
              ${checks(
                "crew",
                crew.map((a) => ({
                  value: a.user.username,
                  label: a.user.username,
                })),
                values.crew,
              )}
              ${errors["crew"]
                ? html`<span class="error" id="f-crew-err"
                    >${errors["crew"]}</span
                  >`
                : null}
            </fieldset>`}
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
  const plan = body["plan"] as { budgetUsd?: number | null } | undefined;
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
    <p class="claim-link-box"><code class="mono" id="claim-link">${link}</code></p>
    <p class="mt">
      ${btn("Copy the link", { type: "button", copy: "claim-link", icon: "copy", variant: "primary", size: "sm" })}
      ${btn("Forges you sent", { href: "/forges", size: "sm" })}
    </p>
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
  return page({
    ctx,
    title: "New forge",
    body: formView(ctx, user, EMPTY, {}, null),
  });
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
    keepAccess: asBool(form, "keepAccess"),
    budgetUsd: field(form, "budgetUsd").trim(),
    modelEndpoint: field(form, "modelEndpoint").trim(),
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
    ...(values.forWhom === "" ? {} : { for: values.forWhom }),
    ...(values.direction.trim() === "" ? {} : { direction: values.direction }),
    ...(key === "" ? {} : { modelKey: key }),
    ...(values.modelEndpoint === "" ? {} : { modelEndpoint: values.modelEndpoint }),
    ...(values.budgetUsd === "" ? {} : { budgetUsd: Number(values.budgetUsd) }),
    dryRun: planOnly,
  });
  if (door.status >= 400)
    return page(
      {
        ctx,
        title: "New forge",
        body: formView(ctx, user, values, errorsOf(door), null),
      },
      door.status === 422 ? 422 : door.status,
    );
  if (planOnly)
    return page({
      ctx,
      title: "New forge",
      body: formView(ctx, user, values, {}, planView(ctx, user, values, door.body)),
    });
  const response = page(
    { ctx, title: "New forge", body: madeView(door.body) },
    door.status,
  );
  // The link is in this body only: never kept by a cache.
  response.headers.set("cache-control", "no-store");
  return response;
}
