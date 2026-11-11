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

import { getPack, resolveRepos } from "../../packs/curated.ts";
import { listAgents } from "../../core/agents.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { giftOf, REDEEM_WORDS } from "../../actions/codes.ts";
import { quotaFull } from "../../spawn/quota.ts";
import { isChildName } from "../../core/proposal_token.ts";
import { childReady } from "../../spawn/ready.ts";
import { childHost, childUrlOf, noRoom, spawnDoor, type Door } from "../../spawn/door.ts";
import {
  LEFT_BEHIND,
  MAX_FOR_CHARS,
  MAX_FRESH_CHARS,
  MAX_DIRECTION_CHARS,
  MAX_BUDGET_USD,
  MIN_BUDGET_USD,
} from "../../spawn/plan.ts";
import { DEFAULT_SIZE, SIZES, sizesView } from "../../spawn/sizes.ts";
import { DEFAULT_TEMPLATE, TEMPLATES, templateOf } from "../../spawn/templates.ts";
import { FOLLOW_LABELS, FOLLOW_WORDS } from "../../spawn/follow_words.ts";
import { dropGift, keepGift, keptGift } from "../gift_cookie.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, type Html } from "../html.ts";
import { noteForgeMade } from "../funnel_door.ts";
import { page, redirect } from "../layout.ts";
import { startRefusalHref, startRefusalOf } from "../start_refusal.ts";
import { pickList } from "../pick.ts";
import { btn, field as formField, row, selectField } from "../ui.ts";

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
  /** A gift code (`actions/codes.ts`): it names the plan, so no checkout and no card. */
  readonly code: string;
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
  followMode: "take-updates",
  keepAccess: false,
  budgetUsd: "",
  modelEndpoint: "",
  size: DEFAULT_SIZE,
  template: DEFAULT_TEMPLATE,
  code: "",
  hadKey: false,
};

/** The fields behind "More options": an error on one opens it. */
const MORE_FIELDS = ["followMode", "crew", "keepAccess", "modelKey", "modelEndpoint", "budgetUsd", "template", "size"];

type Errors = Partial<Record<string, string>>;

const all = (form: Form, name: string): string[] =>
  form
    .getAll(name)
    .filter((v): v is string => typeof v === "string" && v !== "");

/** The door's refusal, beside the field it names: "name: must be …". */
function errorsOf(door: Door): Errors {
  const message = String(door.body["message"] ?? "");
  const m = /^([A-Za-z]+): (.*)$/.exec(message);
  if (door.body["error"] === "invalid" && m) return { [m[1]!]: plainError(m[2]!) };
  return { form: plainError(message) };
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

/** The page's words for what the data names in the API's terms (#10787); the data keeps its own. */
const PLAIN: Readonly<Record<string, string>> = {
  tokens: "access passes",
  "SSH keys": "remote-login keys",
  "agent credentials": "the crew's sign-ins",
};
/**
 * The door's refusals speak to the API and the terminal too; on this page they
 * name the key the way the form does. A test posts each one and reads the page.
 */
const PLAIN_ERRORS: readonly (readonly [RegExp, string])[] = [
  [/^is empty or over 4096 characters[^]*$/, "is empty or too long: paste the whole key from your AI account"],
  [/a subscription token \(sk-ant-oat…\)/g, "a Claude sign-in key (sk-ant-oat…)"],
  [/; send modelKey with it/g, ": add the key too"],
  [/\bmodel key\b/g, "AI account key"],
];
export function plainError(message: string): string {
  return PLAIN_ERRORS.reduce((m, [from, to]) => m.replace(from, to), message);
}

export function plainWords(item: string): string {
  return PLAIN[item] ?? item.replace("its own model key", "its own AI account key");
}

/** The fresh field's error; when there is no picker, the apps' error too, so it is never lost. */
function freshError(errors: Errors, repoCount: number): string | undefined {
  return errors["fresh"] ?? (repoCount === 0 ? errors["apps"] : undefined);
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
    return html`<div class="narrow-wide" data-forges>
      ${pageHead("New forge")}
      <section class="settings-block">
        <h2>No room</h2>
        <p role="status">This forge has no room for another forge: ${full}.</p>
        ${ctx.auth.user?.isAdmin
          ? html`<p><a href="/settings/capacity">Raise the room in settings</a></p>`
          : null}
      </section>
    </div>`;
  const anon = user === undefined;
  const freshErr = freshError(errors, repos.length);
  const lead = repos.length === 0 ? "Pick a name, and say what it is for if you like" : "Pick a name and the apps to start from";
  return html`<div class="narrow-wide" data-forges>
    ${pageHead("New forge", {
      sub: `${lead}${anon ? ". Whoever opens the link becomes its admin." : "; you get one link to send."}`,
      // /forges answers only an admin; to anyone else the link would lead to a 404.
      actions: ctx.auth.user?.isAdmin ? sentLink() : undefined,
    })}
    <p class="muted small" id="hosting-terms">Free within limits: it sleeps when idle, and its crew starts once you add your AI account.</p>
    ${quota ? html`<p role="status" id="quota-full">This forge has no room for another forge: ${quota}.</p>` : null}
    ${errors["form"]
      ? html`<p class="error mb" role="alert">${errors["form"]}</p>`
      : null}
    ${plan}
    <section class="settings-block">
      <h2>Its name and apps</h2>
      <form method="post" action="/forges/new" class="stack" id="new-forge">
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
              hint: `A person or a client, for your list (at most ${MAX_FOR_CHARS} characters). Not copied into the forge.`,
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
        ${repos.length === 0
          ? null
          : pickList({
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
          hint: `One line on what it is; the new forge gets a small app to start from (at most ${MAX_FRESH_CHARS} characters).`,
          // With no picker to show it, an error about the apps is said here.
          ...(freshErr ? { error: freshErr } : {}),
        })}
        <details class="disclosure" ${Object.keys(errors).some((k) => MORE_FIELDS.includes(k)) ? html`open` : null}>
          <summary>More options</summary>
        <fieldset class="field" ${errors["followMode"] ? html`data-invalid` : null}>
          <legend>How it follows this forge's code</legend>
          <label class="check">
            <input
              type="radio"
              name="followMode"
              value="take-updates"
              ${values.followMode !== "tell-me" ? html`checked` : null}
            />
            <span
              >${FOLLOW_LABELS["take-updates"]} <span class="muted small">${FOLLOW_WORDS["take-updates"]}</span></span
            >
          </label>
          <label class="check">
            <input
              type="radio"
              name="followMode"
              value="tell-me"
              ${values.followMode === "tell-me" ? html`checked` : null}
            />
            <span
              >${FOLLOW_LABELS["tell-me"]} <span class="muted small">${FOLLOW_WORDS["tell-me"]}</span></span
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
              <legend>After it is taken over</legend>
              <label class="check">
                <input
                  type="checkbox"
                  name="keepAccess"
                  ${values.keepAccess ? html`checked` : null}
                />
                <span>Keep your owner access (the page they open tells them)</span>
              </label>
            </fieldset>`}
        ${anon
          ? null
          : formField({
              label: values.hadKey ? "AI account key" : "AI account key (optional)",
              name: "modelKey",
              type: "password",
              autocomplete: "off",
              required: values.hadKey,
              hint: values.hadKey
                ? "Type the key again to make the forge: it is never sent back to your browser."
                : "Paste a key from your AI account. It is sealed in the new forge and never shown again.",
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
              hint: "For the key's whole life; the new forge cannot raise it. Needed with a key.",
              ...(errors["budgetUsd"] ? { error: errors["budgetUsd"] } : {}),
            })}
        ${selectField({
          label: "Template",
          name: "template",
          hint: "What the new forge starts from besides the apps you fork. Blank is the default.",
          options: templateOptions(values.template),
          ...(errors["template"] ? { error: errors["template"] } : {}),
        })}
        ${selectField({
          label: "Size (optional)",
          name: "size",
          hint: "Room for the new forge to grow into. Small is the default and is not recorded.",
          options: sizeOptions(values.size),
          ...(errors["size"] ? { error: errors["size"] } : {}),
        })}
          <p class="muted small">
            Never copied: ${LEFT_BEHIND.map(plainWords).join(", ")}. It makes its own.
          </p>
        </details>
        ${codeField(values.code, errors["code"])}
        <div class="form-actions">
          <button class="btn" type="submit" name="do" value="plan">
            See the plan
          </button>
          ${btn("Spawn", { variant: "primary" })}
        </div>
      </form>
    </section>
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
  return html`<section class="settings-block" id="plan">
      <h2>The plan</h2>
      <ul class="mb">
        <li>A forge at <b>${address}</b>.</li>
        <li>Whoever opens the link becomes its admin.</li>
        ${giftLine(body["gift"])}
        ${user === undefined
          ? null
          : html`<li>
              ${values.keepAccess
                ? "You keep owner access once it is taken over; the page they open tells them."
                : "You leave once it is taken over; they can invite you back."}
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
        ${copied.map((c) => html`<li>${plainWords(c)}</li>`)}
      </ul>
      <p class="muted small">
        About ${Math.max(1, Math.round(bytes / 1024))} KB. Nothing is made until
        you press Spawn.
      </p>
      ${typeof note === "string" ? html`<p class="small mt">${note}</p>` : null}
      <p class="mt">${btn("Spawn", { variant: "primary", form: "new-forge" })}</p>
    </section>`;
}

/** "A gift: a <plan> forge, free." */
function giftWords(g: { plan: string }): string {
  return `A gift: a ${g.plan} forge, free.`;
}

function giftLine(g: unknown): Html | null {
  const gift = g as { plan?: unknown } | undefined;
  return typeof gift?.plan === "string" ? html`<li><b>${giftWords({ plan: gift.plan })}</b></li>` : null;
}

/** The way to the list of forges sent; /forges answers only an admin, so only an admin is shown it. */
function sentLink(): Html {
  return btn("Forges you sent", { href: "/forges", size: "sm" });
}

/** The link, shown once: what to do with it, and a way to copy it; the list of forges sent only for an admin. */
export function claimLinkBody(link: string, isAdmin: boolean, note?: string): Html {
  return html`<p class="mb">
      Send this link to the person it is for. It works once, for a day, and
      is shown only now.
    </p>
    <p class="muted small mb">
      Send it as you would a password: to them alone, not to a group.
    </p>
    <ul class="list setting-list">${
      row({
        title: html`<code class="mono" id="claim-link">${link}</code>`,
        trail: btn("Copy the link", { type: "button", copy: "claim-link", icon: "copy", variant: "primary", size: "sm" }),
      })
    }</ul>
    ${isAdmin ? html`<p class="mt">${sentLink()}</p>` : null}
    ${note === undefined ? null : html`<p class="small mt">${note}</p>`}`;
}

function madeView(body: Record<string, unknown>, isAdmin: boolean): Html {
  const link = body["claimUrl"];
  const note = body["keyNote"];
  const name = String(body["name"] ?? "");
  return html`<div class="narrow-wide" data-forges>
    ${pageHead(
      body["existed"] === true ? `${name} already exists` : `${name} is ready`,
    )}
    <section class="settings-block">
      <h2>${typeof link === "string" ? "The link to send" : "Its link"}</h2>
      ${typeof link === "string"
        ? claimLinkBody(link, isAdmin, typeof note === "string" ? note : undefined)
        : html`<p>
            It was made before, so its link is not shown again. Ask for a new
            one if it was lost.
          </p>`}
    </section>
  </div>`;
}

/** The script that waits for the new forge to answer, then goes on to its claim form. */
export const WAIT_JS = /* js */ `
(function () {
  var el = document.getElementById("making");
  if (!el) return;
  var name = el.getAttribute("data-name"), go = document.getElementById("making-go"), tries = 0;
  function late() {
    el.textContent = "This is taking longer than usual. Press Continue to try the new forge now; if it is not up yet, come back to this page in a minute.";
  }
  function again(ms) { if (tries < 120) setTimeout(poll, ms); else late(); }
  function poll() {
    tries++;
    fetch("/forges/" + encodeURIComponent(name) + "/ready", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ready) location.replace(go.href); else again(1000); })
      .catch(function () { again(2000); });
  }
  poll();
})();
`;

/**
 * Screen two of "Start my forge": the new forge's claim form, where the
 * person picks a username and password and lands signed in as its admin
 * (`/claim`). Answering already, the browser is sent straight there; still
 * booting, a waiting page polls `/forges/<name>/ready` and goes on by itself.
 * The code travels in the fragment of that one address and is never copied.
 */
async function walkOn(ctx: Ctx, body: Record<string, unknown>): Promise<Response | undefined> {
  const link = body["claimUrl"];
  const name = String(body["name"] ?? "");
  if (typeof link !== "string" || !/^https?:\/\//.test(link) || !isChildName(name)) return undefined;
  if ((await childReady(ctx.app, name)) === true) {
    const res = redirect(link);
    res.headers.set("cache-control", "no-store");
    return res;
  }
  const response = page({
    ctx,
    title: "Making your forge",
    scriptJs: WAIT_JS,
    body: html`<div class="narrow stack">
      ${pageHead("Making your forge")}
      <p id="making" role="status" data-name="${name}">It will be ready in a moment; you will go on by yourself, to choose a username and a password.</p>
      <p>${btn("Continue", { href: link, variant: "primary", id: "making-go" })}</p>
    </div>`,
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

const asBool = (form: Form, name: string): boolean =>
  field(form, name) === "on";

/**
 * `?pack=name`: the pack as it stands now, as the form's starting values (its
 * public, readable repos ticked and its crew brief as the direction). The
 * form is then what is posted, so a later edit of the pack changes nothing
 * about a forge started from this one.
 */
function fromPack(ctx: Ctx, user: User | undefined): Partial<Values> {
  const pack = getPack(ctx.app.db, ctx.url.searchParams.get("pack") ?? "");
  if (pack === undefined) return {};
  const apps = resolveRepos(ctx.app.db, pack, user).filter((r) => r.left === undefined).map((r) => r.full);
  return { apps, direction: pack.brief.slice(0, MAX_DIRECTION_CHARS) };
}

// GET /forges/new — any signed-in person, or a stranger (agents are refused).
export function newForgePage(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (user && user.kind !== "user") return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const reads = readsFor(ctx, user);
  const rendering = performance.now();
  // A code in the address moves to a cookie and out of the address (the log and history never hold it).
  const inUrl = ctx.url.searchParams.get("code");
  if (inUrl !== null && inUrl !== "") return keepGift(inUrl.slice(0, 64), "/forges/new", ctx.url, ctx.app.config.url);
  // A link with a code arrives filled in, and says it is a gift, or plainly why not.
  const code = keptGift(ctx.request);
  const seen = code === "" ? undefined : giftOf(ctx.app, ctx.request, code);
  const errors: Errors = seen !== undefined && !seen.ok ? { code: `${REDEEM_WORDS[seen.error]}.` } : {};
  const gift = seen?.ok ? html`<p class="small" id="gift" role="status"><b>${giftWords(seen.value)}</b></p>` : null;
  const response = page({
    ctx,
    title: "New forge",
    body: formView(ctx, user, { ...EMPTY, code, name: (ctx.url.searchParams.get("name") ?? "").slice(0, 38), ...fromPack(ctx, user) }, errors, gift, reads),
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
    followMode: field(form, "followMode").trim() || "take-updates",
    keepAccess: asBool(form, "keepAccess"),
    budgetUsd: field(form, "budgetUsd").trim(),
    modelEndpoint: field(form, "modelEndpoint").trim(),
    size: field(form, "size").trim() || DEFAULT_SIZE,
    template: field(form, "template").trim() || DEFAULT_TEMPLATE,
    code: field(form, "code").trim().slice(0, 64),
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
    ...(values.code === "" ? {} : { code: values.code }),
    dryRun: planOnly,
  });
  // The home page's own form says it came from there: a refusal goes back to `/` with the name kept.
  if (door.status >= 400 && user === undefined && field(form, "from") === "home" && door.status !== 401 && door.status !== 403) {
    const kind = startRefusalOf(door);
    return redirect(startRefusalHref(kind, values.name));
  }
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
  noteForgeMade(ctx);
  // A stranger from the home page is not handed a link: the browser goes on to the claim form itself (#11242).
  const going = user === undefined && field(form, "from") === "home" ? await walkOn(ctx, door.body) : undefined;
  if (going !== undefined) return going;
  const response = page(
    { ctx, title: "New forge", body: madeView(door.body, ctx.auth.user?.isAdmin === true) },
    door.status,
  );
  // The link is in this body only: never kept by a cache.
  response.headers.set("cache-control", "no-store");
  if (values.code !== "") response.headers.append("set-cookie", dropGift(ctx.url, ctx.app.config.url));
  return response;
}

/** The code is asked for only when one is in play: filled in from a link, or behind a quiet disclosure that needs no script. */
function codeField(value: string, error: string | undefined): Html {
  const input = formField({ label: "Gift code", name: "code", value, autocomplete: "off", ...(error ? { error } : {}) });
  if (value !== "" || error) return input;
  return html`<details><summary class="small">Have a code?</summary>${input}</details>`;
}
