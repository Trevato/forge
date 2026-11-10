/**
 * Editing a file in the browser.
 *
 * "I want to edit files! Can I make a branch?" — so this page does both in
 * one submit. `actions/contents.ts` is the whole edit as one call (files, a
 * new branch, a pull), which is exactly the shape a person filling in a form
 * wants: one button, one outcome, nothing half-finished if it fails.
 *
 * The rule this page is built around: **never lose a keystroke.** Every
 * refusal — a protected branch, a file that grew too large, an origin that
 * said no — re-renders this page with the text still in the textarea and the
 * reason above it. A form that throws away twenty minutes of typing to tell
 * you about a permission is worse than no editor.
 *
 * Everything works with JavaScript off: it is a `<textarea>` in a `<form>`
 * that POSTs. The gutter, the tab key, the auto-indent and the Markdown
 * preview are `editorJs`, and none of them is load-bearing.
 */

import { fileKind, NO_BYTES } from "../render/kinds.ts";
import { editFiles, MAX_FILE_BYTES } from "../../actions/contents.ts";
import { contribute } from "../../actions/contribute.ts";
import { NO_WRITE_ACCESS } from "../../actions/pull_words.ts";
import { canAdmin, getRepoById } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import { highlightAsset } from "../asset.ts";
import { editorJs } from "../client.ts";
import { detectLanguage } from "../highlight.ts";
import { highlightToHtml } from "../highlight-html.ts";
import { loadRepo, notFoundPage, pageHead, signInFirst } from "../chrome.ts";
import { field as formValue, readForm, type Form } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { TOO_LARGE_TO_EDIT } from "../edit_words.ts";
import { flashTo, fragment, page } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import {
  browseBase,
  localScope,
  type ProposeTarget,
  type RepoScope,
} from "../scope.ts";
import { btn, field, icon, sizeWithTokens } from "../ui.ts";
import { pathCrumbs, refSetFrom } from "./refs.ts";

/** What the form is holding, so a refusal can hand every word back. */
export interface Draft {
  ref: string;
  path: string;
  content: string;
  subject: string;
  body: string;
  target: "current" | "new";
  branch: string;
  pull: boolean;
  pullTitle: string;
  pullBody: string;
  /** A new file lets you type the path; an existing one does not. */
  creating: boolean;
  /** True when committing straight to `ref` is not on offer at all. */
  mustBranch: boolean;
  /**
   * Set when this edit is a *contribution*: it lands on a fork and opens a
   * pull upstream. There is no "commit directly" in that world, so the
   * whole "where this lands" fieldset is replaced by the propose card.
   */
  propose?: ProposeTarget;
  error?: string;
  /**
   * The field an error is about. Without it the error is the form's own (not
   * allowed, branch moved) and is the page's flash.
   */
  errorOn?: "path" | "message" | "branch";
}

/**
 * Where the live-highlighted editor gives up and hands you a plain textarea.
 *
 * The mirror re-renders on a frame; on a file this size that stops being free,
 * and a slow editor is worse than an unhighlighted one. Both limits are the
 * kind of file nobody hand-edits in a browser anyway — a lockfile, a bundle,
 * a fixture — so the fallback is the honest answer rather than a defeat.
 */
export const MAX_MIRROR_BYTES = 200_000;
export const MAX_MIRROR_LINES = 10_000;

/** Whether this text gets the highlighted mirror, and in what language. */
export function mirrorFor(
  path: string,
  content: string,
): { lang: string; mirror: boolean } {
  const lang = detectLanguage(
    path,
    content.slice(0, content.indexOf("\n") + 1 || 200),
  );
  const tooBig =
    content.length > MAX_MIRROR_BYTES || countLines(content) > MAX_MIRROR_LINES;
  return { lang, mirror: !tooBig };
}

function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** A branch name from a file path: `alice/edit-src-lamp-ts`. */
export function suggestBranch(username: string, path: string): string {
  const leaf = (path.split("/").pop() ?? path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${username}/edit-${leaf === "" ? "file" : leaf}`;
}

/** The words for a refused edit. Every branch of the union gets one. */
export function editErrorText(error: unknown): string {
  if (typeof error === "string") {
    if (error === "forbidden" || error === "unauthorized")
      return NO_WRITE_ACCESS;
    if (error === "origin_owner_only")
      return "This repository mirrors an origin, and only the account that connected it can write through to it.";
    if (error === "origin_unreachable")
      return "The origin could not be reached, so nothing was written here either.";
    if (error === "origin_refused")
      return "The origin refused this change, so nothing landed here either.";
    if (error === "origin_protected")
      return "The operator protects this repository at its origin, so nothing is pushed to it from here. Propose the change from your fork.";
    if (error === "origin_read_only")
      return "This account was connected read-only, so nothing is written through it.";
    if (error === "origin_paused")
      return "This connection is not verified yet, so writes through it are paused. Check it again under Settings → Origins.";
    return "That edit could not be saved.";
  }
  const e = error as { kind?: string; branch?: string; message?: string };
  switch (e.kind) {
    case "protected_branch":
      return `${e.branch} is protected. Commit to a new branch and open a pull request instead — the text below is untouched.`;
    case "file_too_large":
    case "commit_too_large":
      return `That file is over the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB limit for a web edit. Push it with git instead.`;
    case "invalid_path":
      return "That path is not one this repository can hold.";
    case "no_files":
      return "There was nothing to commit.";
    case "invalid_branch":
      return "That branch name is not one git will take.";
    case "branch_failed":
      return e.message === undefined
        ? "That branch could not be created — it may already exist."
        : `That branch could not be created: ${e.message}`;
    case "branch_moved":
      return "The branch moved while you were editing. Open it again and reapply your change.";
    case "land_refused":
      return e.message ?? "The origin refused this change.";
    case "pull_failed":
      return "The commit landed, but the pull request could not be opened.";
    default:
      return "That edit could not be saved.";
  }
}

// ---- the page ----

function editorForm(
  scope: RepoScope,
  draft: Draft,
  username: string,
  o: { lang: string; mirror: boolean },
): Html {
  const base = scope.base;
  const { lang, mirror } = o;
  const encoded = encodeURIComponent(draft.ref);
  const suggestion =
    draft.branch !== "" ? draft.branch : suggestBranch(username, draft.path);
  const pathError =
    draft.error !== undefined && draft.errorOn === "path" && draft.creating
      ? draft.error
      : undefined;

  return html`<form
    method="post"
    action="${draft.propose?.action ?? `${base}/edit`}"
    class="editor-form"
  >
    <input type="hidden" name="ref" value="${draft.ref}" />
    ${draft.creating
      ? raw('<input type="hidden" name="creating" value="1" />')
      : html`<input type="hidden" name="path" value="${draft.path}" />`}

    <div class="editor-head">
      ${when(
        draft.creating,
        () =>
          html`<input
            class="input mono"
            name="path"
            value="${draft.path}"
            placeholder="path/to/file.ts"
            aria-label="File path"
            autocomplete="off"
            spellcheck="false"
            required
            ${pathError
              ? raw('aria-invalid="true" aria-describedby="f-path-err"')
              : null}
          />`,
      )}
      ${when(!draft.creating, () =>
        pathCrumbs(base, scope.facts.name, draft.ref, draft.path, true),
      )}
      <span class="spacer"></span>
      ${when(
        !draft.creating,
        () =>
          html`<span
            class="muted small num"
            id="editor-size"
            title="The file as opened, before your changes"
            >${sizeWithTokens(
              new TextEncoder().encode(draft.content).byteLength,
              draft.path,
            )}</span
          >`,
      )}
      ${when(
        isMarkdownPath(draft.path) || draft.creating,
        () =>
          html`<button
              class="btn"
              data-size="sm"
              data-variant="secondary"
              type="button"
              data-editor-tab="write"
              aria-selected="true"
              hidden
            >
              Write
            </button>
            <button
              class="btn"
              data-size="sm"
              data-variant="ghost"
              type="button"
              data-editor-tab="preview"
              aria-selected="false"
              hidden
            >
              Preview
            </button>`,
      )}
    </div>

    ${when(
      pathError,
      (message) =>
        html`<div class="field" data-invalid>
          <span class="error" id="f-path-err">${message}</span>
        </div>`,
    )}
    <div
      class="editor-wrap"
      id="editor-write"
      data-lang="${lang}"
      ${mirror ? raw('data-mirror="1"') : null}
    >
      <div class="editor-gutter" id="editor-gutter" aria-hidden="true"></div>
      <div>
        ${when(mirror, () =>
          raw(
            `<pre class="mono" id="editor-mirror" aria-hidden="true">${mirrorHtml(
              draft.content,
              lang,
            )}</pre>`,
          ),
        )}
        <textarea
          class="editor mono"
          name="content"
          id="f-content"
          aria-label="File contents"
          spellcheck="false"
          wrap="off"
        >
${draft.content}</textarea
        >
      </div>
    </div>
    <div
      class="prose"
      id="editor-preview"
      data-preview="${base}/preview"
      data-path="${draft.path}"
      hidden
    ></div>

    <section class="settings-block editor-commit">
      <h2>${draft.creating ? "Create the file" : "Commit the change"}</h2>
      ${field({
          label: "Commit message",
          name: "message",
          value: draft.subject,
          placeholder: draft.creating
            ? `Create ${draft.path || "a file"}`
            : `Update ${draft.path}`,
          required: true,
          ...(draft.error && draft.errorOn === "message"
            ? { error: draft.error }
            : {}),
        })}
        ${field({
          label: "Extended description",
          name: "description",
          type: "textarea",
          rows: 3,
          value: draft.body,
        })}
        ${draft.propose !== undefined
          ? proposeBlock(draft, draft.propose, suggestion)
          : landingBlock(draft, suggestion)}
        <div class="form-actions">
          ${btn(
            draft.propose !== undefined
              ? "Propose this change"
              : draft.creating
                ? "Create file"
                : "Commit change",
            { variant: "primary" },
          )}
          ${btn("Cancel", {
            href: draft.creating
              ? `${base}/tree/${encoded}`
              : `${base}/blob/${encoded}/${draft.path}`,
            variant: "ghost",
          })}
          <span class="spacer"></span>
          ${when(!draft.creating && draft.propose === undefined, () =>
            btn("Delete this file", {
              href: `${base}/delete/${encoded}/${draft.path}`,
              variant: "danger",
              size: "sm",
              icon: "trash",
            }),
          )}
        </div>
    </section>
  </form>`;
}

/**
 * "Where this lands", for a repository that can take the commit: directly on
 * the ref, or on a new branch with an optional pull request behind it.
 */
function landingBlock(draft: Draft, suggestion: string): Html {
  return html`<fieldset class="editor-target">
    <legend>Where this lands</legend>
    <label class="check">
      <input
        type="radio"
        name="target"
        value="current"
        ${draft.target === "current" && !draft.mustBranch
          ? raw("checked")
          : null}
        ${draft.mustBranch ? raw("disabled") : null}
      />
      <span
        >Commit directly to <span class="mono">${draft.ref}</span> ${when(
          draft.mustBranch,
          () =>
            html`<span class="hint"
              >Not available: ${draft.ref} is protected, or is not a
              branch.</span
            >`,
        )}</span
      >
    </label>
    <label class="check">
      <input
        type="radio"
        name="target"
        value="new"
        ${draft.target === "new" || draft.mustBranch ? raw("checked") : null}
      />
      <span class="grow"
        >Create a new branch
        <input
          class="input mono"
          id="f-branch"
          name="branch"
          value="${suggestion}"
          aria-label="New branch name"
          autocomplete="off"
          spellcheck="false"
        />
      </span>
    </label>
    <div id="f-pull-block">
      <label class="check">
        <input
          type="checkbox"
          name="pull"
          value="1"
          ${draft.pull ? raw("checked") : null}
        />
        <span
          >Open a pull request from the new branch back into
          <span class="mono">${draft.ref}</span></span
        >
      </label>
      ${field({
        label: "Pull request title",
        name: "pullTitle",
        value: draft.pullTitle,
        placeholder: "Same as the commit message",
      })}
      ${field({
        label: "Pull request description",
        name: "pullBody",
        type: "textarea",
        rows: 3,
        value: draft.pullBody,
      })}
    </div>
  </fieldset>`;
}

/**
 * The propose card: what happens to this text when you cannot push.
 *
 * It says the whole outcome in one sentence, up front, with both repository
 * names in it — the fork the commit lands on and the repository the pull
 * opens against — because "commit" means something different here and
 * finding that out afterwards is the worst possible time. There is no
 * "commit directly" radio, because there is no such option.
 */
function proposeBlock(
  draft: Draft,
  propose: ProposeTarget,
  suggestion: string,
): Html {
  const branchError =
    draft.error !== undefined && draft.errorOn === "branch"
      ? draft.error
      : undefined;
  return html`<fieldset class="editor-target propose">
    <legend>${icon("fork")}Propose a change</legend>
    <p class="propose-line">
      This lands on your fork
      <a href="${browseBase(propose.originId, propose.fork)}"
        ><span class="mono">${propose.fork}</span></a
      >
      on a new branch and opens a pull on
      <a href="${browseBase(propose.originId, propose.upstream)}"
        ><span class="mono">${propose.upstream}</span></a
      >.
      <span class="hint"
        >You cannot push to ${propose.upstream}. If you have no fork of it at
        ${propose.host} yet, one is made for you first.</span
      >
    </p>
    <div class="field">
      <label for="f-branch">Branch on the fork</label>
      <input
        class="input mono"
        id="f-branch"
        name="branch"
        value="${suggestion}"
        aria-label="New branch name"
        autocomplete="off"
        spellcheck="false"
        required
        ${branchError
          ? raw('aria-invalid="true" aria-describedby="f-branch-err"')
          : null}
      />
      ${when(
        branchError,
        (message) =>
          html`<span class="error" id="f-branch-err">${message}</span>`,
      )}
      <span class="hint"
        >The pull's head, as
        <span class="mono">${propose.fork.split("/")[0]}:${suggestion}</span
        >.</span
      >
    </div>
    ${field({
      label: "Pull request title",
      name: "pullTitle",
      value: draft.pullTitle,
      placeholder: "Same as the commit message",
    })}
    ${field({
      label: "Pull request description",
      name: "pullBody",
      type: "textarea",
      rows: 3,
      value: draft.pullBody,
    })}
  </fieldset>`;
}

export async function editorPage(
  ctx: Ctx,
  scope: RepoScope,
  draft: Draft,
): Promise<Response> {
  const username = ctx.auth.user?.username ?? "edit";
  const shape = mirrorFor(draft.path, draft.content);
  // An error with no field of its own is the form's: a flash, as everywhere.
  const formLevel =
    draft.error !== undefined &&
    (draft.errorOn === undefined ||
      (draft.errorOn === "path" && !draft.creating) ||
      (draft.errorOn === "branch" && draft.propose === undefined))
      ? draft.error
      : undefined;
  // Only an editor that will actually use the tokenizer pays for it — and
  // only that page relaxes the script CSP to admit a file from this origin.
  const asset = shape.mirror ? await highlightAsset() : null;
  return page({
    ctx,
    ...(formLevel !== undefined
      ? { flash: { tone: "danger" as const, message: formLevel } }
      : {}),
    title: `${draft.creating ? "New file" : draft.path} · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`${pageHead(
      html`${icon(
        draft.propose !== undefined
          ? "fork"
          : draft.creating
            ? "filePlus"
            : "pencil",
      )}${draft.propose !== undefined
        ? draft.creating
          ? "Proposing a new file"
          : "Proposing a change"
        : draft.creating
          ? "New file"
          : "Editing a file"}`,
      { sub: html`in <span class="mono">${scope.fullName}</span>` },
    )}
    ${editorForm(scope, draft, username, {
      lang: shape.lang,
      mirror: shape.mirror && asset !== null,
    })}`,
    scriptJs: editorJs,
    ...(shape.mirror && asset !== null ? { scriptAsset: asset.path } : {}),
  });
}

/** The mirror's first paint, rendered by the same code the browser will use. */
function mirrorHtml(content: string, lang: string): string {
  return highlightToHtml(content, lang as Parameters<typeof highlightToHtml>[1])
    .split("\n")
    .map((line) => `<div>${line}</div>`)
    .join("");
}

/** A file not yet named is written as prose until its name says otherwise. */
const isMarkdownPath = (path: string): boolean =>
  path === "" || fileKind(path, NO_BYTES) === "markdown";

/**
 * The repository and the situation an edit route needs, or the refusal. A
 * reader who cannot write gets the same 404 a stranger gets — the editor is
 * not a place to learn that a repository exists but is not yours.
 */
function editContext(ctx: Ctx): { scope: RepoScope; ref: string } | Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const scope = localScope(ctx, repo);
  if (!scope.caps.write) return notFoundPage(ctx);
  const ref = ctx.params.ref ?? "";
  if (!isSafeRef(ref)) return notFoundPage(ctx);
  return { scope, ref };
}

/**
 * Whether committing straight onto this ref is even on offer. A tag is not a
 * branch, and a protected default takes commits from repo admins only — the
 * same rule `editFiles` enforces, said out loud here rather than discovered
 * after the typing.
 */
async function mustBranchFrom(
  ctx: Ctx,
  scope: RepoScope,
  ref: string,
): Promise<boolean> {
  const repo = scope.repo;
  if (repo === undefined) return true;
  const refs = await refSetFrom(scope.source);
  if (!refs.branches.includes(ref)) return true;
  return (
    ref === repo.defaultBranch &&
    repo.protectDefault &&
    !canAdmin(ctx.app.db, repo, ctx.auth.user)
  );
}

// GET /:owner/:name/edit/:ref/*path
export async function editPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const found = timePhase(ctx.request, "repo", () => editContext(ctx));
  if (found instanceof Response) return found;
  const { scope, ref } = found;
  const path = ctx.params.path ?? "";
  if (!isSafeTreePath(path)) return notFoundPage(ctx);

  const blob = await timePhaseAsync(ctx.request, "blob", () =>
    scope.source.blob(ref, path),
  );
  if (!blob.ok) return notFoundPage(ctx);
  if (blob.value.kind !== "text") {
    return flashTo(
      ctx,
      `${scope.base}/blob/${encodeURIComponent(ref)}/${path}`,
      {
        tone: "danger",
        message:
          blob.value.kind === "binary"
            ? "That file is binary — edit it with git, not a textarea."
            : TOO_LARGE_TO_EDIT,
      },
    );
  }
  const content = new TextDecoder().decode(blob.value.body);
  const draft = await timePhaseAsync(ctx.request, "refs", () =>
    blankDraft(ctx, scope, ref, {
      path,
      content,
      creating: false,
    }),
  );
  return await timePhaseAsync(ctx.request, "render", () =>
    editorPage(ctx, scope, draft),
  );
}

/**
 * A fresh draft for this repository, this ref and this file — with the
 * propose/commit decision already made, so every page and every refusal
 * renders the same form.
 */
export async function blankDraft(
  ctx: Ctx,
  scope: RepoScope,
  ref: string,
  o: { path: string; content: string; creating: boolean },
): Promise<Draft> {
  const propose = scope.propose;
  // A contribution always branches: there is nothing here to commit onto.
  const mustBranch =
    propose !== undefined || (await mustBranchFrom(ctx, scope, ref));
  return {
    ref,
    path: o.path,
    content: o.content,
    subject: "",
    body: "",
    target: mustBranch ? "new" : "current",
    branch: suggestBranch(
      ctx.auth.user?.username ?? "edit",
      o.creating ? "new-file" : o.path,
    ),
    pull: mustBranch,
    pullTitle: "",
    pullBody: "",
    creating: o.creating,
    mustBranch,
    ...(propose === undefined ? {} : { propose }),
  };
}

// GET /:owner/:name/new/:ref[/*path]
export async function newFilePage(ctx: Ctx): Promise<Response> {
  const found = editContext(ctx);
  if (found instanceof Response) return found;
  const { scope, ref } = found;
  const dir = ctx.params.path ?? "";
  if (dir !== "" && !isSafeTreePath(dir)) return notFoundPage(ctx);
  return await editorPage(
    ctx,
    scope,
    await blankDraft(ctx, scope, ref, {
      path: dir === "" ? "" : `${dir}/`,
      content: "",
      creating: true,
    }),
  );
}

// ---- proposing a change to a repository you cannot push to ----

/**
 * The words for a refused contribution.
 *
 * Everything `editFiles` can say, plus the four ways the *origin* half can
 * go wrong. They are worth their own sentences: a fork that has not appeared
 * yet is a "try again in a moment", an origin that refused is not, and a
 * commit that landed with no pull behind it is a third thing again — the
 * work is safe on the fork and only the proposal is missing.
 */
export function contributeErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const e = error as { kind: string; reason?: unknown };
    if (e.kind === "edit_failed") return editErrorText(e.reason);
    if (e.kind === "pull_failed")
      return "The commit landed on your fork, but the pull request could not be opened there. Nothing was lost — open it from the fork.";
    return editErrorText(error);
  }
  const code = String(error);
  if (code === "fork_timeout")
    return "The origin took the fork request and the fork has not appeared yet. Give it a moment and propose this again — nothing was lost.";
  if (code === "mirror_failed")
    return "The fork exists at the origin, but a local copy of it could not be made, so there was nowhere to commit.";
  if (code === "invalid_branch")
    return "That branch name is not one git will take.";
  if (code === "unknown_base")
    return "That branch does not exist on the upstream any more.";
  return editErrorText(code);
}

/** Everything the propose form said, read back off the body. */
function proposeDraft(form: Form, propose: ProposeTarget): Draft {
  return {
    ref: formValue(form, "ref"),
    path: formValue(form, "path").trim().replace(/^\/+/, ""),
    content: formValue(form, "content"),
    subject: formValue(form, "message").trim(),
    body: formValue(form, "description").trim(),
    target: "new",
    branch: formValue(form, "branch").trim(),
    pull: true,
    pullTitle: formValue(form, "pullTitle").trim(),
    pullBody: formValue(form, "pullBody").trim(),
    creating: formValue(form, "creating") === "1",
    mustBranch: true,
    propose,
  };
}

/**
 * Grab their repo, branch, edit, propose it back — the whole thing, from one
 * form.
 *
 * `actions/contribute.ts` does the work as a single call, which is exactly
 * what a form wants: one button, one outcome, nothing half-finished if a
 * step fails. This side's job is the two things a page owes a person — hand
 * every typed word back when it is refused, and land them on the pull when
 * it is not.
 */
export async function runContribute(
  ctx: Ctx,
  scope: RepoScope,
  propose: ProposeTarget,
  form: Form,
): Promise<Response> {
  const draft = proposeDraft(form, propose);
  const refuse = (
    message: string,
    errorOn?: Draft["errorOn"],
  ): Promise<Response> =>
    editorPage(ctx, scope, {
      ...draft,
      error: message,
      ...(errorOn ? { errorOn } : {}),
    });

  if (!isSafeRef(draft.ref)) return notFoundPage(ctx);
  if (draft.path === "" || !isSafeTreePath(draft.path))
    return refuse("Give the file a path this repository can hold.", "path");
  if (draft.subject === "") return refuse("A commit needs a message.", "message");
  if (draft.branch === "")
    return refuse("Give the branch on your fork a name.", "branch");

  const message =
    draft.body === "" ? draft.subject : `${draft.subject}\n\n${draft.body}`;
  const proposed = await contribute(ctx.app, ctx.auth.user, {
    originId: propose.originId,
    fullName: propose.upstream,
    branch: draft.branch,
    base: draft.ref,
    message,
    files: [{ path: draft.path, content: draft.content }],
    openPull: {
      title: draft.pullTitle === "" ? draft.subject : draft.pullTitle,
      body: draft.pullBody,
    },
  });
  if (!proposed.ok) return refuse(contributeErrorText(proposed.error));

  const result = proposed.value;
  const pull = result.pull;
  const where =
    result.via === "fork"
      ? `your fork ${result.forkFullName ?? result.fork.name}`
      : propose.upstream;
  if (pull === undefined)
    return flashTo(ctx, `/${result.fork.ownerName}/${result.fork.name}`, {
      message: `Committed ${draft.branch} to ${where}.`,
    });

  // The pull belongs to the origin. When we also mirror the upstream it was
  // imported here and has a page of its own; when we do not, the live browse
  // of that pull is still a page in this product — reading it there beats
  // being thrown out to another forge mid-workflow.
  const local = pull.local;
  const mirror =
    local === undefined ? undefined : getRepoById(ctx.app.db, local.repoId);
  const dest =
    mirror === undefined
      ? `${browseBase(propose.originId, propose.upstream)}/pulls/${pull.number}`
      : `/${mirror.ownerName}/${mirror.name}/pulls/${pull.number}`;
  return flashTo(ctx, dest, {
    message: `Committed to ${where} and opened ${propose.upstream}#${pull.number} at ${propose.host}.`,
  });
}

/**
 * POST /:owner/:name/contribute — propose a change from a mirror.
 *
 * A mirror of a repository the origin says you cannot push to takes its
 * edits this way: the commit goes to your fork there, the pull opens on the
 * upstream, and (because we hold a mirror of that upstream) the pull is
 * imported and shown here.
 */
export async function contributeSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const scope = localScope(ctx, repo);
  if (!scope.caps.write || scope.propose === undefined)
    return notFoundPage(ctx);
  return runContribute(ctx, scope, scope.propose, form);
}

/**
 * POST /:owner/:name/edit — the one write.
 *
 * Everything the form said travels in the body, including the ref and the
 * path, so a failure can rebuild the exact page the person was looking at.
 */
export async function editSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const scope = localScope(ctx, repo);
  if (!scope.caps.write) return notFoundPage(ctx);

  const ref = formValue(form, "ref");
  const path = formValue(form, "path").trim().replace(/^\/+/, "");
  const content = formValue(form, "content");
  const subject = formValue(form, "message").trim();
  const description = formValue(form, "description").trim();
  const target = formValue(form, "target") === "new" ? "new" : "current";
  const branch = formValue(form, "branch").trim();
  const pull = formValue(form, "pull") !== "" && target === "new";
  const pullTitle = formValue(form, "pullTitle").trim();
  const pullBody = formValue(form, "pullBody").trim();
  const creating = formValue(form, "creating") === "1";

  const mustBranch = await mustBranchFrom(ctx, scope, ref);
  const draft: Draft = {
    ref,
    path,
    content,
    subject,
    body: description,
    target,
    branch,
    pull,
    pullTitle,
    pullBody,
    creating,
    mustBranch,
  };
  const refuse = (
    message: string,
    errorOn?: Draft["errorOn"],
  ): Promise<Response> =>
    editorPage(ctx, scope, {
      ...draft,
      error: message,
      ...(errorOn ? { errorOn } : {}),
    });

  if (!isSafeRef(ref)) return notFoundPage(ctx);
  if (path === "" || !isSafeTreePath(path))
    return refuse("Give the file a path this repository can hold.", "path");
  if (subject === "") return refuse("A commit needs a message.", "message");

  const message = description === "" ? subject : `${subject}\n\n${description}`;
  const written = await editFiles(ctx.app, ctx.auth.user, repo, {
    branch: ref,
    base: ref,
    message,
    files: [{ path, content }],
    ...(target === "new" ? { newBranch: branch } : {}),
    ...(pull
      ? {
          openPull: {
            title: pullTitle === "" ? subject : pullTitle,
            body: pullBody,
          },
        }
      : {}),
  });
  if (!written.ok) return refuse(editErrorText(written.error));

  const landed = written.value;
  if (landed.pull !== undefined) {
    return flashTo(ctx, `${scope.base}/pulls/${landed.pull.number}`, {
      message: `Committed to ${landed.branch} and opened this pull request.`,
    });
  }
  return flashTo(
    ctx,
    `${scope.base}/blob/${encodeURIComponent(landed.branch)}/${path}`,
    {
      message:
        landed.branch === ref
          ? `Committed to ${landed.branch}.`
          : `Committed to the new branch ${landed.branch}.`,
    },
  );
}

// ---- deleting a file ----

// GET /:owner/:name/delete/:ref/*path
export async function deleteFilePage(ctx: Ctx): Promise<Response> {
  const found = editContext(ctx);
  if (found instanceof Response) return found;
  const { scope, ref } = found;
  const path = ctx.params.path ?? "";
  if (!isSafeTreePath(path)) return notFoundPage(ctx);
  const blob = await scope.source.blob(ref, path);
  if (!blob.ok) return notFoundPage(ctx);
  const mustBranch = await mustBranchFrom(ctx, scope, ref);
  const encoded = encodeURIComponent(ref);

  return page({
    ctx,
    title: `Delete ${path} · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`<div class="narrow-wide">
      ${pageHead(html`Delete <span class="mono">${path}</span>?`)}
      <section class="settings-block" id="delete-file">
        <p>
          It is removed from
          <span class="mono">${mustBranch ? "a new branch" : ref}</span> in one
          commit. Every other branch keeps it, and so does every commit that
          already exists — this is a deletion in history, not from it.
        </p>
        <form method="post" action="${scope.base}/delete" class="mt">
          <input type="hidden" name="ref" value="${ref}" />
          <input type="hidden" name="path" value="${path}" />
          <input
            type="hidden"
            name="target"
            value="${mustBranch ? "new" : "current"}"
          />
          ${when(
            mustBranch,
            () =>
              html`<input
                type="hidden"
                name="branch"
                value="${suggestBranch(
                  ctx.auth.user?.username ?? "edit",
                  path,
                )}"
              />`,
          )}
          ${field({
            label: "Commit message",
            name: "message",
            value: `Delete ${path}`,
            required: true,
          })}
          <div class="form-actions">
            ${btn("Delete this file", { variant: "danger" })}
            ${btn("Cancel", {
              href: `${scope.base}/blob/${encoded}/${path}`,
              variant: "ghost",
            })}
          </div>
        </form>
      </section>
    </div>`,
  });
}

// POST /:owner/:name/delete
export async function deleteFileSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const scope = localScope(ctx, repo);
  if (!scope.caps.write) return notFoundPage(ctx);

  const ref = formValue(form, "ref");
  const path = formValue(form, "path");
  const branch = formValue(form, "branch").trim();
  const target = formValue(form, "target") === "new" ? "new" : "current";
  const message = formValue(form, "message").trim() || `Delete ${path}`;
  if (!isSafeRef(ref) || !isSafeTreePath(path)) return notFoundPage(ctx);

  const encoded = encodeURIComponent(ref);
  const written = await editFiles(ctx.app, ctx.auth.user, repo, {
    branch: ref,
    base: ref,
    message,
    files: [{ path, content: null }],
    ...(target === "new" && branch !== "" ? { newBranch: branch } : {}),
  });
  if (!written.ok) {
    return flashTo(ctx, `${scope.base}/delete/${encoded}/${path}`, {
      tone: "danger",
      message: editErrorText(written.error),
    });
  }
  const landed = written.value.branch;
  return flashTo(
    ctx,
    `${scope.base}/tree/${encodeURIComponent(landed)}${
      path.includes("/") ? `/${path.slice(0, path.lastIndexOf("/"))}` : ""
    }`,
    { message: `Deleted ${path} on ${landed}.` },
  );
}

/**
 * POST /:owner/:name/preview — the Markdown preview tab.
 *
 * It renders with the same renderer the file page will use, so what you see
 * is what lands. It writes nothing and stores nothing; it is a POST only
 * because a document body does not belong in a query string, and it goes
 * through `readForm` so it carries the same same-origin check as every other
 * form on the page.
 */
export async function previewSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return fragment(html``, { status: 404 });
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const scope = localScope(ctx, repo);
  if (!scope.caps.write) return fragment(html``, { status: 404 });
  const body = formValue(form, "body");
  const path = formValue(form, "path");
  const markdown = path === "" || /\.(md|markdown)$/i.test(path);
  return fragment(markdown ? renderMarkdown(body) : html`<pre>${body}</pre>`, {
    request: ctx.request,
  });
}
