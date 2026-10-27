/**
 * POST /:owner/:name/settings/holds — hold new work on a file, or release it.
 * Through `adminForm`: an admin of the repository, same-origin, admin scope;
 * the hold names the signed-in admin (`actions/file_holds.ts`).
 *
 * The form's answer is `fileHoldForm`, so any page that offers a hold posts
 * through the same words and only says where to return.
 */

import { holdFileAs, releaseFileAs, type FileHoldError } from "../../actions/file_holds.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { err, type Result } from "../../kernel/result.ts";
import { repoBase } from "../chrome.ts";
import { field, type Form } from "../form.ts";
import { flashTo } from "../layout.ts";
import { adminForm } from "./settings.ts";

export async function fileHoldUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  return fileHoldForm(ctx, form, repo, `${repoBase(repo)}/settings#file-holds`);
}

/**
 * Hold or release the form's `path` in `repo`, then return to `to` with a
 * flash. A repository that is missing (`undefined`) answers exactly as one
 * the caller cannot read, so the refusal never says which it was.
 */
export function fileHoldForm(ctx: Ctx, form: Form, repo: Repo | undefined, to: string): Response {
  const path = field(form, "path");
  const missing = err<FileHoldError>("not_found");
  if (field(form, "verb") === "release") {
    const released: Result<boolean, FileHoldError> = repo
      ? releaseFileAs(ctx.app, ctx.auth.user, repo, path)
      : missing;
    return flashTo(
      ctx,
      to,
      released.ok
        ? { message: released.value ? `${path} is free again.` : `${path} was not held.` }
        : { tone: "danger", message: "That path could not be released." },
    );
  }
  const held = repo ? holdFileAs(ctx.app, ctx.auth.user, repo, path) : missing;
  return flashTo(
    ctx,
    to,
    held.ok
      ? { message: `New work on ${held.value.path} is held.` }
      : {
          tone: "danger",
          message:
            held.error === "invalid_path"
              ? "A held path is relative, without .. or empty parts, and under 300 characters."
              : "That file could not be held.",
        },
  );
}
