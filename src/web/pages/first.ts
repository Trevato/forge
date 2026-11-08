/** POST /:owner/:name/issues/:number/first — a writer puts a ready issue first (#7808). */
import { putIssueFirst } from "../../actions/first.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { backTo, readForm } from "../form.ts";
import { flashOrJson } from "../layout.ts";

export async function firstSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = backTo(form, `${repoBase(repo)}/map`);
  const put = putIssueFirst(ctx.app, ctx.auth.user, repo, Number(ctx.params.number));
  if (!put.ok) {
    if (put.error.kind === "not_found") return notFoundPage(ctx);
    return flashOrJson(ctx, dest, { tone: "danger", message: put.error.message });
  }
  return flashOrJson(ctx, dest, { message: `#${put.value.number} is first.` });
}
