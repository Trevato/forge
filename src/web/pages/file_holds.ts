/**
 * POST /:owner/:name/settings/holds — hold new work on a file, or release it.
 * Through `adminForm`: an admin of the repository, same-origin, admin scope;
 * the hold names the signed-in admin (`actions/file_holds.ts`).
 */

import { holdFileAs, releaseFileAs } from "../../actions/file_holds.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { field } from "../form.ts";
import { flashTo } from "../layout.ts";
import { adminForm } from "./settings.ts";

export async function fileHoldUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const to = `${repoBase(repo)}/settings#file-holds`;
  const path = field(form, "path");
  if (field(form, "verb") === "release") {
    const released = releaseFileAs(ctx.app, ctx.auth.user, repo, path);
    return flashTo(
      ctx,
      to,
      released.ok
        ? { message: released.value ? `${path} is free again.` : `${path} was not held.` }
        : { tone: "danger", message: "That path could not be released." },
    );
  }
  const held = holdFileAs(ctx.app, ctx.auth.user, repo, path);
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
