/**
 * A guest pull on its page (`origins/guest.ts`): everyone sees that it came
 * from another forge and its preview runs without the app's variables; a
 * person who can write the repository sees the one action that lifts that. The POST is
 * read through `readForm` (the `rw` floor and the same-origin check), and
 * `approveGuestPull` asks again who may. Any stranger's pull (`crew/stranger.ts`)
 * says what happens next in one sentence, read from the diff on the server.
 */

import type { Ctx } from "../../http/context.ts";
import type { Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { approveGuestPull } from "../../actions/pulls.ts";
import {
  guestWaits,
  mayApproveGuest,
} from "../../origins/guest.ts";
import { foldWall } from "../../crew/fold_walls.ts";
import { isStrangerPull, strangerGuard, strangerNext } from "../../crew/stranger.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { pullContext } from "../studio/change.ts";
import { btn } from "../ui.ts";

export const GUEST_WAITS =
  "This pull comes from a guest: its preview runs without the app's variables or a forge token until a person who can write here approves it.";
export const GUEST_APPROVED = "Approved as a guest: its preview starts again with the app's variables, and the crew takes it up.";

/**
 * A stranger's open pull, as one plain headed section (#9575, #10004): what
 * happens next, in one sentence read from the diff on the server; for a guest
 * nobody approved yet, the guest's words and the writer's approval in the same section, with
 * the walls a person should weigh when nothing is guarded (a guarded path
 * is named in the sentence already). Empty for anyone else's pull.
 */
export async function strangerCard(ctx: Ctx, repo: Repo, pull: Pull, action: string, walls: readonly string[] = []): Promise<Html> {
  if (pull.state !== "open" || pull.mergedAt !== null) return html``;
  const stranger = isStrangerPull(ctx.app.db, repo, pull);
  const waits = guestWaits(ctx.app.db, pull);
  if (!stranger && !waits) return html``;
  const guarded = await strangerGuard(ctx.app, repo, pull);
  const next = stranger ? html`<p ${guarded.length > 0 ? html`role="alert"` : null}>${strangerNext(repo, guarded)}</p>` : null;
  if (!waits && next !== null)
    return html`<section class="settings-block mb">
      <h2>What happens next</h2>
      ${next}
    </section>`;
  const writer = mayApproveGuest(ctx.app.db, repo, ctx.auth.user);
  return html`<section class="settings-block mb">
    <h2>A guest</h2>
    <p>${GUEST_WAITS}</p>
    ${next}
    ${guarded.length > 0 ? null : walls.map((wall) => html`<p role="alert">Look closely: ${wall}.</p>`)}
    ${writer
      ? html`<form class="mt" method="post" action="${action}">
          ${btn("Approve this guest", { size: "sm", icon: "check" })}
        </form>`
      : null}
  </section>`;
}

/** What a person should weigh before approving a guest: paths nobody but a person decides on. */
export async function guestWalls(ctx: Ctx, repo: Repo, pull: Pull, baseOid: string): Promise<string[]> {
  return guestWaits(ctx.app.db, pull) && baseOid !== "" ? foldWall(ctx.app, repo, pull, baseOid) : [];
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
