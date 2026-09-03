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

import { editFiles, MAX_FILE_BYTES } from "../../actions/contents.ts";
import { canAdmin } from "../../core/repos.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import { editorJs } from "../client.ts";
import { loadRepo, notFoundPage, pageHead, signInFirst } from "../chrome.ts";
import { field as formValue, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, fragment, page, redirect } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { localScope, type RepoScope } from "../scope.ts";
import { btn, card, field, icon } from "../ui.ts";
import { pathCrumbs, refSetFrom } from "./refs.ts";

/** What the form is holding, so a refusal can hand every word back. */
interface Draft {
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
  error?: string;
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
      return "You do not have write access to this repository.";
    if (error === "origin_owner_only")
      return "This repository mirrors an origin, and only the account that connected it can write through to it.";
    if (error === "origin_unreachable")
      return "The origin could not be reached, so nothing was written here either.";
    if (error === "origin_refused")
      return "The origin refused this change, so nothing landed here either.";
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

function editorForm(scope: RepoScope, draft: Draft, username: string): Html {
  const base = scope.base;
  const encoded = encodeURIComponent(draft.ref);
  const suggestion =
    draft.branch !== "" ? draft.branch : suggestBranch(username, draft.path);

  return html`<form method="post" action="${base}/edit" class="editor-form">
    <input type="hidden" name="ref" value="${draft.ref}" />
    ${draft.creating
      ? raw('<input type="hidden" name="creating" value="1" />')
      : html`<input type="hidden" name="path" value="${draft.path}" />`}

    <div class="editor-head">
      ${when(
        draft.creating,
        () =>
          html`<input
            class="input mono editor-path"
            name="path"
            value="${draft.path}"
            placeholder="path/to/file.ts"
            aria-label="File path"
            autocomplete="off"
            spellcheck="false"
            required
          />`,
      )}
      ${when(!draft.creating, () =>
        pathCrumbs(base, scope.facts.name, draft.ref, draft.path, true),
      )}
      <span class="spacer"></span>
      <button
        class="btn editor-tab"
        data-size="sm"
        data-variant="ghost"
        type="button"
        data-editor-tab="write"
        aria-selected="true"
        hidden
      >
        Write
      </button>
      <button
        class="btn editor-tab"
        data-size="sm"
        data-variant="ghost"
        type="button"
        data-editor-tab="preview"
        aria-selected="false"
        hidden
      >
        Preview
      </button>
    </div>

    <div class="editor-wrap" id="editor-write">
      <div class="editor-gutter" id="editor-gutter" aria-hidden="true"></div>
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
    <div
      class="prose editor-preview"
      id="editor-preview"
      data-preview="${base}/preview"
      hidden
    ></div>

    ${card(
      html`${field({
          label: "Commit message",
          name: "message",
          value: draft.subject,
          placeholder: draft.creating
            ? `Create ${draft.path || "a file"}`
            : `Update ${draft.path}`,
          required: true,
        })}
        ${field({
          label: "Extended description",
          name: "description",
          type: "textarea",
          rows: 3,
          value: draft.body,
        })}
        <fieldset class="editor-target">
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
              ${draft.target === "new" || draft.mustBranch
                ? raw("checked")
                : null}
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
        </fieldset>
        <div class="form-actions">
          ${btn(draft.creating ? "Create file" : "Commit change", {
            variant: "primary",
          })}
          ${btn("Cancel", {
            href: draft.creating
              ? `${base}/tree/${encoded}`
              : `${base}/blob/${encoded}/${draft.path}`,
            variant: "ghost",
          })}
          <span class="spacer"></span>
          ${when(!draft.creating, () =>
            btn("Delete this file", {
              href: `${base}/delete/${encoded}/${draft.path}`,
              variant: "danger",
              size: "sm",
              icon: "trash",
            }),
          )}
        </div>`,
      { extra: "editor-commit" },
    )}
  </form>`;
}

function editorPage(ctx: Ctx, scope: RepoScope, draft: Draft): Response {
  const username = ctx.auth.user?.username ?? "edit";
  return page({
    ctx,
    title: `${draft.creating ? "New file" : draft.path} · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`${pageHead(
      html`${icon(draft.creating ? "filePlus" : "pencil")}${draft.creating
        ? "New file"
        : "Editing a file"}`,
      { sub: html`in <span class="mono">${scope.fullName}</span>` },
    )}
    ${when(
      draft.error,
      (message) =>
        html`<p class="error-note" role="alert">
          ${icon("alert")}<span>${message}</span>
        </p>`,
    )}
    ${editorForm(scope, draft, username)}`,
    scriptJs: editorJs,
  });
}

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
  const found = editContext(ctx);
  if (found instanceof Response) return found;
  const { scope, ref } = found;
  const path = ctx.params.path ?? "";
  if (!isSafeTreePath(path)) return notFoundPage(ctx);

  const blob = await scope.source.blob(ref, path);
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
            : "That file is too large to edit here.",
      },
    );
  }
  const mustBranch = await mustBranchFrom(ctx, scope, ref);
  return editorPage(ctx, scope, {
    ref,
    path,
    content: new TextDecoder().decode(blob.value.body),
    subject: "",
    body: "",
    target: mustBranch ? "new" : "current",
    branch: suggestBranch(ctx.auth.user?.username ?? "edit", path),
    pull: mustBranch,
    pullTitle: "",
    pullBody: "",
    creating: false,
    mustBranch,
  });
}

// GET /:owner/:name/new/:ref[/*path]
export async function newFilePage(ctx: Ctx): Promise<Response> {
  const found = editContext(ctx);
  if (found instanceof Response) return found;
  const { scope, ref } = found;
  const dir = ctx.params.path ?? "";
  if (dir !== "" && !isSafeTreePath(dir)) return notFoundPage(ctx);
  const mustBranch = await mustBranchFrom(ctx, scope, ref);
  return editorPage(ctx, scope, {
    ref,
    path: dir === "" ? "" : `${dir}/`,
    content: "",
    subject: "",
    body: "",
    target: mustBranch ? "new" : "current",
    branch: suggestBranch(ctx.auth.user?.username ?? "edit", "new-file"),
    pull: mustBranch,
    pullTitle: "",
    pullBody: "",
    creating: true,
    mustBranch,
  });
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
  const refuse = (message: string): Response =>
    editorPage(ctx, scope, { ...draft, error: message });

  if (!isSafeRef(ref)) return notFoundPage(ctx);
  if (path === "" || !isSafeTreePath(path))
    return refuse("Give the file a path this repository can hold.");
  if (subject === "") return refuse("A commit needs a message.");

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
      ${card(
        html`<p>
            It is removed from
            <span class="mono">${mustBranch ? "a new branch" : ref}</span> in
            one commit. Every other branch keeps it, and so does every commit
            that already exists — this is a deletion in history, not from it.
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
          </form>`,
        {
          tone: "danger",
          head: html`${icon("alert")}
            <h2>Delete a file</h2>`,
        },
      )}
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
  if (!repo) return fragment(html``, 404);
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const scope = localScope(ctx, repo);
  if (!scope.caps.write) return fragment(html``, 404);
  const body = formValue(form, "body");
  const path = formValue(form, "path");
  const markdown = path === "" || /\.(md|markdown)$/i.test(path);
  return fragment(markdown ? renderMarkdown(body) : html`<pre>${body}</pre>`);
}
