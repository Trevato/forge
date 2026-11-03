/**
 * A guest pull on its page (`origins/guest.ts`): everyone sees that it came
 * from another forge and its preview runs without the app's variables; a
 * person who can write the repository sees the one action that lifts that. The POST is
 * read through `readForm` (the `rw` floor and the same-origin check), and
 * `approveGuestPull` asks again who may.
 */

import type { Ctx } from "../../http/context.ts";
import type { Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { approveGuestPull } from "../../actions/pulls.ts";
import {
  guestApproval,
  isGuestPull,
  mayApproveGuest,
} from "../../origins/guest.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { pullContext } from "../studio/change.ts";
import { btn, card, icon } from "../ui.ts";

export const GUEST_WAITS =
  "This pull comes from another forge, so it is a guest: its preview runs without the app's variables or a forge token, and the crew leaves it alone, until a person who can write here approves it.";
export const GUEST_APPROVED = "Approved as a guest: its preview starts again with the app's variables, and the crew takes it up.";

/** The guest notice; empty for a pull from this forge, or one already approved. */
export function guestCard(ctx: Ctx, repo: Repo, pull: Pull, action: string): Html {
  if (pull.state !== "open" || pull.mergedAt !== null) return html``;
  if (!isGuestPull(ctx.app.db, pull)) return html``;
  if (guestApproval(ctx.app.db, pull.id) !== undefined) return html``;
  const writer = mayApproveGuest(ctx.app.db, repo, ctx.auth.user);
  return card(
    html`<p>${GUEST_WAITS}</p>
      ${writer
        ? html`<form method="post" action="${action}">
            ${btn("Approve this guest", { size: "sm", icon: "check" })}
          </form>`
        : null}`,
    {
      extra: "mb",
      head: html`${icon("globe")}
        <h2>A guest</h2>`,
    },
  );
}

/** POST /:owner/:name/pulls/:number/approve-guest — a writer's word, once. */
export async function pullApproveGuestSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const done = approveGuestPull(ctx.app, ctx.auth.user, found.repo, found.pull);
  if (!done.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        done.error === "forbidden"
          ? "Only a person with write access can approve a guest."
          : "This pull is from this forge: it is no guest.",
    });
  return flashTo(ctx, dest, { message: GUEST_APPROVED });
}
