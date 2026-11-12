/**
 * Editing a JSON, YAML or TOML config file as a form (#7336, #7337).
 *
 * GET  /:owner/:name/config/:ref/*path — the file's values as fields, typed
 *      by its schema when one is found (`render/json-schema.ts`), else by
 *      the values themselves.
 * POST /:owner/:name/config — one route, three steps:
 *      `op`          add, remove or reorder a card; the form comes back.
 *      step=review   the change as a diff, with a commit message.
 *      step=save     a writer commits to the branch; anyone else (a
 *                    reader, an agent, a writer facing a protected branch)
 *                    proposes it: one commit on a new branch and a pull
 *                    (`actions/propose_edit.ts`).
 *
 * The file is written back in its own key order and indent (YAML and TOML
 * keep their comments: `render/config-format.ts`), and a save that changes
 * nothing writes nothing. Everything works as a plain form
 * POST; a browser with HTML validation checks a schema's bounds inline.
 * A file that is not valid goes back to its source view, with the error and
 * its line.
 */

import { editFiles } from "../../actions/contents.ts";
import { proposeEdit, proposeEditText } from "../../actions/propose_edit.ts";
import { canAdmin } from "../../core/repos.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, pageHead, signInFirst } from "../chrome.ts";
import { field as formValue, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { isFormConfig, languageOf, parseConfig, writeConfig } from "../render/config-format.ts";
import { applyOp, configFields, countFields, MAX_FIELDS, readValues } from "../render/config-form.ts";
import { lineDiff, parseJson, sameDoc, stringify, type Json } from "../render/json-doc.ts";
import { findSchema, validate, type FoundSchema } from "../render/json-schema.ts";
import { localScope, type RepoScope } from "../scope.ts";
import { btn, field, icon } from "../ui.ts";
import { editErrorText } from "./edit.ts";
import { refSetFrom } from "./refs.ts";

/** Bigger than this, the form is no help; the source editor is. */
export const MAX_FORM_BYTES = 256 * 1024;
/** A schema file larger than this is not read. */
const MAX_SCHEMA_BYTES = 256 * 1024;

/** Names the file's text as it was opened, so a save sees whether it moved. */
export const digestOf = (text: string): string => Bun.hash(text).toString(16);

const blobHref = (scope: RepoScope, ref: string, path: string, view = ""): string =>
  `${scope.base}/blob/${encodeURIComponent(ref)}/${path}${view}`;

/** Who this is to the file: commits straight on, or proposes. */
async function commitsDirectly(ctx: Ctx, scope: RepoScope, ref: string): Promise<boolean> {
  const repo = scope.repo;
  const user = ctx.auth.user;
  if (repo === undefined || user === undefined || !scope.caps.write || user.kind === "agent") return false;
  const refs = await refSetFrom(scope.source);
  if (!refs.branches.includes(ref)) return false;
  return !(ref === repo.defaultBranch && repo.protectDefault && !canAdmin(ctx.app.db, repo, user));
}

/** The repository, the signed-in person, and a ref and path fit to edit; or the refusal. */
function configContext(ctx: Ctx, ref: string, path: string): RepoScope | Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!isSafeRef(ref) || !isSafeTreePath(path) || !isFormConfig(path)) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  // A mirror you cannot push to proposes through its origin: the source editor's card.
  if (scope.propose !== undefined)
    return flashTo(ctx, blobHref(scope, ref, path), {
      tone: "danger",
      message: "This file mirrors an origin. Propose a change to it from the editor.",
    });
  return scope;
}

/** The file's text at `ref`, when it is text the form can hold. */
async function readText(scope: RepoScope, ref: string, path: string, max: number): Promise<string | undefined> {
  const blob = await scope.source.blob(ref, path);
  if (!blob.ok || blob.value.kind !== "text" || blob.value.size > max) return undefined;
  return new TextDecoder().decode(blob.value.body);
}

const schemaFor = (scope: RepoScope, ref: string, path: string, doc: Json): Promise<FoundSchema | undefined> =>
  findSchema(path, doc, (p) => (isSafeTreePath(p) ? readText(scope, ref, p, MAX_SCHEMA_BYTES) : Promise.resolve(undefined)));

interface FormState {
  readonly ref: string;
  readonly path: string;
  readonly base: string;
  readonly doc: Json;
  readonly found: FoundSchema | undefined;
  readonly errors?: ReadonlyMap<string, string>;
  readonly typed?: ReadonlyMap<string, string>;
  readonly flash?: { tone: "danger" | "success"; message: string };
}

const hidden = (s: FormState, doc: Json): Html => html`<input type="hidden" name="ref" value="${s.ref}" />
  <input type="hidden" name="path" value="${s.path}" />
  <input type="hidden" name="base" value="${s.base}" />
  <input type="hidden" name="doc" value="${stringify(doc)}" />`;

function head(scope: RepoScope, s: FormState, proposing: boolean, step: string): Html {
  return pageHead(html`${icon(proposing ? "fork" : "pencil")}${s.path.split("/").pop() ?? s.path}`, {
    sub: html`${step} · <span class="mono">${s.path}</span> on <span class="mono">${s.ref}</span> in
      <span class="mono">${scope.fullName}</span>${
        s.found === undefined
          ? html` · fields from the values`
          : html` · fields from <a href="${blobHref(scope, s.ref, s.found.from)}" class="mono">${s.found.from}</a>`
      }`,
  });
}

async function formPage(ctx: Ctx, scope: RepoScope, s: FormState): Promise<Response> {
  const proposing = !(await commitsDirectly(ctx, scope, s.ref));
  // The first submit button in the form, so Enter in any field reviews
  // rather than pressing a card's Up or Remove.
  const review = btn(proposing ? "Review and propose" : "Review changes", { name: "step", value: "review", variant: "primary" });
  return page({
    ctx,
    ...(s.flash === undefined ? {} : { flash: s.flash }),
    title: `${s.path} · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`${head(scope, s, proposing, "Editing settings")}
      <form method="post" action="${scope.base}/config" class="config-form">
        <section class="settings-block">
          <div class="bar mb">
            <h2>Settings</h2><span class="spacer"></span>
            ${review}
          </div>
          <p class="muted small">Enter in a field reviews the change.</p>
          ${hidden(s, s.doc)}
          <input type="hidden" name="from" value="form" />
          ${configFields(s.doc, {
            found: s.found,
            ...(s.errors === undefined ? {} : { errors: s.errors }),
            ...(s.typed === undefined ? {} : { typed: s.typed }),
          })}
        </section>
        <div class="form-actions">
          ${review}
          ${btn("Source", { href: blobHref(scope, s.ref, s.path, "?view=source"), variant: "outline" })}
          ${when(scope.caps.write, () =>
            btn("Edit as text", { href: `${scope.base}/edit/${encodeURIComponent(s.ref)}/${s.path}`, variant: "ghost" }),
          )}
        </div>
      </form>`,
  });
}

async function reviewPage(
  ctx: Ctx,
  scope: RepoScope,
  s: FormState,
  diff: { before: string; after: string },
  o: { message?: string; description?: string; error?: string } = {},
): Promise<Response> {
  const proposing = !(await commitsDirectly(ctx, scope, s.ref));
  const lines = lineDiff(diff.before, diff.after);
  return page({
    ctx,
    ...(s.flash === undefined ? {} : { flash: s.flash }),
    title: `Review ${s.path} · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`${head(scope, s, proposing, "Review")}
      <section class="settings-block">
        <h2>The change</h2>
        <pre class="mono config-diff" aria-label="The change">${lines.map(
          (l) => html`<span data-op="${l.op === " " ? "same" : l.op === "+" ? "add" : "del"}">${l.op} ${l.text}</span>\n`,
        )}</pre>
      </section>
      <form method="post" action="${scope.base}/config">
       <section class="settings-block">
        <h2>Commit message</h2>
        ${hidden(s, s.doc)}
        ${field({
          name: "message",
          label: "Commit message",
          value: o.message ?? `Update ${s.path}`,
          required: true,
          ...(o.error === undefined ? {} : { error: o.error }),
        })}
        ${field({ name: "description", label: "Description", type: "textarea", rows: 3, value: o.description ?? "" })}
        <p class="muted small">${
          proposing
            ? scope.caps.write
              ? html`This goes on a new branch, with a pull request into <span class="mono">${s.ref}</span>.`
              : html`You cannot push here, so this goes on a branch of your fork, with a pull request into <span class="mono">${s.ref}</span>.`
            : html`One commit on <span class="mono">${s.ref}</span>.`
        }</p>
       </section>
        <div class="form-actions">
          ${btn(proposing ? "Propose change" : `Commit to ${s.ref}`, { name: "step", value: "save", variant: "primary", icon: proposing ? "fork" : "check" })}
          ${btn("Back to the form", { name: "step", value: "edit", variant: "outline", formnovalidate: true })}
        </div>
      </form>`,
  });
}

// GET /:owner/:name/config/:ref/*path
export async function configPage(ctx: Ctx): Promise<Response> {
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  const scope = configContext(ctx, ref, path);
  if (scope instanceof Response) return scope;
  const blob = await scope.source.blob(ref, path);
  if (!blob.ok) return notFoundPage(ctx);
  const tooBig = (message: string): Response =>
    flashTo(ctx, blobHref(scope, ref, path, "?view=source"), { tone: "danger", message });
  if (blob.value.kind !== "text" || blob.value.size > MAX_FORM_BYTES)
    return tooBig("This file is too large to edit as a form. Edit it as text, or with git.");
  const text = new TextDecoder().decode(blob.value.body);
  const parsed = parseConfig(path, text);
  if (!parsed.ok) {
    const e = parsed.error;
    return tooBig(`Not valid ${languageOf(path)}: ${e.message} at line ${e.line}, column ${e.column}. Fix it in the source first.`);
  }
  if (countFields(parsed.value) > MAX_FIELDS)
    return tooBig(`This file has more than ${MAX_FIELDS.toLocaleString()} values, too many for a form. Edit it as text.`);
  return formPage(ctx, scope, {
    ref,
    path,
    base: digestOf(text),
    doc: parsed.value,
    found: await schemaFor(scope, ref, path, parsed.value),
  });
}

/** The document the form carried, with what was typed into it. */
function docFrom(form: Form): { doc: Json; errors: Map<string, string>; typed: Map<string, string> } | undefined {
  const parsed = parseJson(formValue(form, "doc"));
  if (!parsed.ok || countFields(parsed.value) > MAX_FIELDS) return undefined;
  if (formValue(form, "from") !== "form") return { doc: parsed.value, errors: new Map(), typed: new Map() };
  return readValues(parsed.value, (name) => {
    const v = form.get(name);
    return typeof v === "string" ? v : undefined;
  });
}

// POST /:owner/:name/config
export async function configSubmit(ctx: Ctx): Promise<Response> {
  // Who may write is settled before the body is read: a private repository
  // answers a stranger 404, as every page about it does.
  if (!loadRepo(ctx)) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const ref = formValue(form, "ref");
  const path = formValue(form, "path");
  const scope = configContext(ctx, ref, path);
  if (scope instanceof Response) return scope;
  const repo = scope.repo;
  const user = ctx.auth.user;
  if (repo === undefined || user === undefined) return notFoundPage(ctx);

  const read = docFrom(form);
  if (read === undefined) return flashTo(ctx, blobHref(scope, ref, path), { tone: "danger", message: "That form could not be read. Open the file again." });
  const current = await readText(scope, ref, path, MAX_FORM_BYTES);
  if (current === undefined) return notFoundPage(ctx);
  const original = parseConfig(path, current);
  if (!original.ok)
    return flashTo(ctx, blobHref(scope, ref, path, "?view=source"), {
      tone: "danger",
      message: `${path} is no longer valid ${languageOf(path)} on ${ref}. Fix it in the source first.`,
    });
  const found = await schemaFor(scope, ref, path, read.doc);
  let state: FormState = { ref, path, base: formValue(form, "base"), doc: read.doc, found };

  const op = formValue(form, "op");
  if (op !== "") return formPage(ctx, scope, { ...state, doc: applyOp(read.doc, op, found) });

  const step = formValue(form, "step");
  if (step === "edit") return formPage(ctx, scope, state);

  const errors = new Map([...validate(read.doc, found), ...read.errors]);
  if (errors.size > 0)
    return formPage(ctx, scope, {
      ...state,
      errors,
      typed: read.typed,
      flash: { tone: "danger", message: errors.size === 1 ? "One field needs a fix." : `${errors.size} fields need a fix.` },
    });

  if (state.base !== digestOf(current)) {
    // Someone else saved first. Their file is now the base; the form keeps
    // this person's values, and a second review shows them over the new file.
    return formPage(ctx, scope, {
      ...state,
      base: digestOf(current),
      flash: { tone: "danger", message: `${path} changed on ${ref} since you opened it. Check your values, then review again.` },
    });
  }
  if (sameDoc(original.value, read.doc))
    return formPage(ctx, scope, { ...state, flash: { tone: "success", message: "Nothing changed, so there is nothing to save." } });

  const written = writeConfig(path, current, original.value, read.doc);
  // What is written must read back as exactly the form's document.
  const check = written.ok ? parseConfig(path, written.text) : undefined;
  if (!written.ok || check === undefined || !check.ok || !sameDoc(check.value, read.doc))
    return formPage(ctx, scope, {
      ...state,
      flash: {
        tone: "danger",
        message: written.ok ? "That change could not be written back safely. Edit the file as text." : written.message,
      },
    });
  const after = written.text;
  if (step !== "save") return reviewPage(ctx, scope, state, { before: current, after });

  const subject = formValue(form, "message").trim();
  const description = formValue(form, "description").trim();
  if (subject === "")
    return reviewPage(ctx, scope, state, { before: current, after }, { description, error: "A commit needs a message." });
  const message = description === "" ? subject : `${subject}\n\n${description}`;
  const files = [{ path, content: after }];

  if (await commitsDirectly(ctx, scope, ref)) {
    const written = await editFiles(ctx.app, user, repo, { branch: ref, base: ref, message, files });
    if (!written.ok) {
      state = { ...state, flash: { tone: "danger", message: editErrorText(written.error) } };
      return reviewPage(ctx, scope, state, { before: current, after }, { message: subject, description });
    }
    return flashTo(ctx, blobHref(scope, ref, path), { tone: "success", message: `Committed to ${ref}.` });
  }

  const proposed = await proposeEdit(ctx.app, user, repo, { base: ref, files, message, title: subject, body: description });
  if (!proposed.ok) {
    const words = proposeEditText(proposed.error);
    state = { ...state, flash: { tone: "danger", message: words } };
    return reviewPage(ctx, scope, state, { before: current, after }, { message: subject, description });
  }
  const pull = proposed.value.pull;
  return flashTo(ctx, `${scope.base}/pulls/${pull.number}`, {
    tone: "success",
    message: `Proposed on ${proposed.value.head.ownerName}/${proposed.value.head.name}:${proposed.value.branch}, as this pull request.`,
  });
}
