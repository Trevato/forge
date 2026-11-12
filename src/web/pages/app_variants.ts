/**
 * The variant board: an app's branches kept running as variants, side by
 * side — each one's preview, what it last made, and the values that set it
 * apart — with the controls a writer has: register a branch, set its
 * values, retire it, make it main (docs/features/variants.md).
 */

import {
  makeMain,
  registerVariant,
  retireVariant,
  setVariantValues,
  variantBoard,
  variantRefusalText,
  type VariantCard,
} from "../../actions/app_variants.ts";
import { VARIANTS_MAX } from "../../core/variants.ts";
import { canWrite } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { field as formValue, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, confirmAction, disclosure, empty, field, listCard, row } from "../ui.ts";

const hidden = (error: string): boolean => error === "unauthorized" || error === "not_found" || error === "forbidden";

const valueLines = (values: Readonly<Record<string, string>>): string =>
  Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n");

/** One variant, one row: its facts, then a single row of actions and the values form folded under it. */
function variantRow(base: string, c: VariantCard, writer: boolean): Html {
  const here = `${base}/variants/${c.label}`;
  return row({
    title: c.label,
    lead: badge(c.state, { tone: c.state === "running" ? "success" : c.state === "failed" ? "danger" : "default" }),
    trail: html`<span class="muted small mono">${c.branch}</span>`,
    data: { "variant-card": c.label },
    facts: [
      {
        label: "Values",
        value: Object.keys(c.values).length === 0
          ? html`<span class="muted">the app's defaults</span>`
          : html`${Object.entries(c.values).map(([name, value]) => html`<code>${name}=${value}</code> `)}`,
      },
      {
        label: "Last made",
        value: c.output === undefined
          ? html`<span class="muted">nothing yet</span>`
          : c.output.path === ""
            ? c.output.title
            : html`<a href="${base}/app/${c.env}/open?to=${encodeURIComponent(c.output.path)}">${c.output.title}</a>`,
      },
    ],
    after: html`<div class="bar">
        ${btn("Open preview", { href: `${base}/app/${c.env}/open`, size: "sm", variant: "outline", icon: "external" })}
        ${when(writer, () => html`<form method="post" action="${here}/main">${btn("Make this main", { size: "sm", variant: "outline" })}</form>
          ${confirmAction({ action: `${here}/retire`, verb: "Retire", size: "sm" })}`)}
      </div>
      ${when(writer, () => disclosure("Edit values", html`<form method="post" action="${here}/values">
        ${field({ label: `Values for ${c.label}`, name: "values", type: "textarea", rows: 3, mono: true, spellcheck: false, value: valueLines(c.values), hint: "NAME=value, one per line." })}
        ${btn("Save values", { size: "sm", variant: "outline" })}
      </form>`, { small: true }))}`,
  });
}

// GET /:owner/:name/variants
export async function variantBoardPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const board = await variantBoard(ctx.app, repo);
  if (board === undefined) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const base = repoBase(repo);
  const writer = ctx.auth.user !== undefined && canWrite(ctx.app.db, repo, ctx.auth.user);
  const budget = board.max === null ? `${board.live} previews running` : `${board.live} of ${board.max} previews running`;
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    <h2 class="mt">Variants</h2>
    <p class="muted small">A branch kept running beside production, with values of its own: ${budget}.</p>
    ${board.cards.length === 0
      ? empty({ title: "No variants yet", note: "Register a branch to run it as a variant." })
      : listCard(board.cards.map((c) => variantRow(base, c, writer)))}
    ${when(writer && board.cards.length < VARIANTS_MAX, () => html`<form method="post" action="${base}/variants" class="mt">
      <h3>Run a branch as a variant</h3>
      ${field({ label: "Branch", name: "branch", required: true, mono: true, spellcheck: false })}
      ${field({ label: "Label", name: "label", hint: "Defaults from the branch name.", spellcheck: false, maxlength: 16 })}
      ${btn("Run as variant", { variant: "primary" })}
    </form>`)}`;
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: `Variants · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body }),
  );
}

type Verb = (ctx: Ctx, repo: NonNullable<ReturnType<typeof loadRepo>>, form: Form) => Promise<Response>;

async function mutate(ctx: Ctx, verb: Verb): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  return verb(ctx, repo, form);
}

const refused = (ctx: Ctx, to: string, error: string | { kind: "bad_values"; message: string }): Response =>
  typeof error === "string" && hidden(error)
    ? notFoundPage(ctx)
    : flashTo(ctx, to, {
        tone: "danger",
        message: typeof error === "string" ? variantRefusalText(error) : variantRefusalText("bad_values", error.message),
      });

// POST /:owner/:name/variants
export const registerSubmit = (ctx: Ctx): Promise<Response> =>
  mutate(ctx, async (c, repo, form) => {
    const to = `${repoBase(repo)}/variants`;
    const label = formValue(form, "label");
    const made = await registerVariant(c.app, c.auth.user, repo, { branch: formValue(form, "branch"), ...(label === "" ? {} : { label }) });
    return made.ok ? flashTo(c, to, { message: `Running ${made.value.branch} as the ${made.value.label} variant.` }) : refused(c, to, made.error);
  });

// POST /:owner/:name/variants/:label/values
export const valuesSubmit = (ctx: Ctx): Promise<Response> =>
  mutate(ctx, async (c, repo, form) => {
    const to = `${repoBase(repo)}/variants`;
    const saved = await setVariantValues(c.app, c.auth.user, repo, c.params.label ?? "", formValue(form, "values"));
    return saved.ok ? flashTo(c, to, { message: "Saved. The variant restarts with it." }) : refused(c, to, saved.error);
  });

// POST /:owner/:name/variants/:label/retire
export const retireSubmit = (ctx: Ctx): Promise<Response> =>
  mutate(ctx, async (c, repo) => {
    const to = `${repoBase(repo)}/variants`;
    const gone = await retireVariant(c.app, c.auth.user, repo, c.params.label ?? "");
    return gone.ok ? flashTo(c, to, { message: "Retired. The branch is kept." }) : refused(c, to, gone.error);
  });

// POST /:owner/:name/variants/:label/main
export const mainSubmit = (ctx: Ctx): Promise<Response> =>
  mutate(ctx, async (c, repo) => {
    const to = `${repoBase(repo)}/variants`;
    const pull = await makeMain(c.app, c.auth.user, repo, c.params.label ?? "");
    return pull.ok
      ? flashTo(c, `${repoBase(repo)}/pulls/${pull.value.number}`, { message: "Merge this pull to make the variant main." })
      : refused(c, to, pull.error);
  });
