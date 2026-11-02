/**
 * A hold, as a page says it (`core/holds.ts`): who holds the pull, why and
 * since when, and that no rule will review or land it meanwhile. With
 * `act`, a person who writes the repository also gets the way to let it
 * go, or, on a pull nobody holds, the one line that holds it. Both post
 * under `/pulls/:number` (`holdSubmit`, `releaseSubmit`).
 */

import { getHold, WHY_MAX } from "../../core/holds.ts";
import { marksByName } from "../../core/marks.ts";
import type { Pull } from "../../core/pulls.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { btn, card, icon, time, userLink } from "../ui.ts";

export function holdCard(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  o: { act: boolean; bare?: boolean },
): Html | null {
  const hold = getHold(ctx.app.db, pull.id);
  const user = ctx.auth.user;
  const open = pull.state === "open" && pull.mergedAt === null;
  // The same people the action lets through: a person, who writes here.
  const may =
    o.act &&
    user !== undefined &&
    user.kind === "user" &&
    canWrite(ctx.app.db, repo, user);
  const thread = `${repoBase(repo)}/pulls/${pull.number}`;
  if (hold !== undefined) {
    if (o.bare) return null;
    return card(
      html`<p>
          ${userLink(hold.heldByName, {
            mark: marksByName(ctx.app.db, [hold.heldByName]).get(
              hold.heldByName,
            ),
          })}
          holds this, ${time(hold.heldAt)}: ${hold.why}
        </p>
        ${when(
          hold.until === "green",
          () => html`<p class="muted small">Releases on green.</p>`,
        )}
        <p class="muted small">
          No rule sends it to review or lands it until it is released. A person
          can still ship it.
        </p>
        ${when(
          may,
          () =>
            html`<form class="bar mt" method="post" action="${thread}/release">
              ${btn("Release", { size: "sm" })}
            </form>`,
        )}`,
      {
        tone: "attn",
        id: "hold",
        head: html`${icon("lock")}
          <h2>Held</h2>`,
      },
    );
  }
  if (!may || !open) return null;
  // Folded into the page's "More": the form alone, with the anchor.
  if (o.bare)
    return html`<form class="bar mt" id="hold" method="post" action="${thread}/hold">
      <label class="muted small" for="hold-why">Hold this pull request</label>
      <input
        id="hold-why"
        class="input"
        name="why"
        required
        maxlength="${WHY_MAX}"
        placeholder="Why, in one line"
        aria-label="Why it is held, in one line"
      />
      <label class="check"
        ><input type="checkbox" name="until" value="green" />
        <span>until green</span></label
      >
      ${btn("Hold", { size: "sm" })}
    </form>`;
  return html`<details class="mt mb" id="hold">
    <summary class="muted small">Hold this pull request</summary>
    <form class="bar mt" method="post" action="${thread}/hold">
      <input
        class="input"
        name="why"
        required
        maxlength="${WHY_MAX}"
        placeholder="Why, in one line"
        aria-label="Why it is held, in one line"
      />
      <label class="check"
        ><input type="checkbox" name="until" value="green" />
        <span>until green</span></label
      >
      ${btn("Hold", { size: "sm" })}
    </form>
    <p class="muted small">
      While it is held, no rule sends it to review or lands it. You can still
      ship it yourself.
    </p>
  </details>`;
}
