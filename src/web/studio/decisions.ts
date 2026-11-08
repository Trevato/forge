/**
 * The inbox's decision cards: `decisionsFor` words and pictures each ask
 * `asks.ts` finds, and `decisionForm` / `decisionButtons` draw what a person
 * can do about it. Every button posts to the route a person could have
 * posted to by hand (`actions.ts`); the asks themselves — which there are,
 * how they score, how they count — stay in `asks.ts`.
 */

import { previewEnv } from "../../apps/data.ts";
import { appsForRepos } from "../../core/apps.ts";
import { issueTitles } from "../../core/proposals.ts";
import { looksForApps, lookUrl } from "../../core/looks.ts";
import type { Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { handoverLines } from "../../crew/guard.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";
import { thumbLook } from "../pages/looks.ts";
import { changeHref } from "./nouns.ts";
import { testsClause } from "./words.ts";
import { reviewerPaused } from "../../crew/reviewer_paused.ts";
import { reviewWhy, scoredFor, waitingOn, type Decision, type Scored } from "./asks.ts";

/** Dollars as a person reads them: cents when small, whole when not. */
const dollars = (n: number): string => (n < 10 ? n.toFixed(2) : n.toFixed(0));

/**
 * The decisions waiting on the viewer, worded and pictured. A change's own
 * page passes `evenDismissed`: setting an ask aside quiets the lists, never
 * the decision on the thing itself, and names its `pull`: only that pull's
 * own decisions are read, never the repository's whole list.
 */
export function decisionsFor(
  ctx: Ctx,
  allRepos: readonly Repo[],
  options: { evenDismissed?: boolean; pull?: string } = {},
): Decision[] {
  const db = ctx.app.db;
  const candidates = options.evenDismissed
    ? scoredFor(db, ctx.auth.user, allRepos, Date.now(), options.pull)
    : waitingOn(db, ctx.auth.user, allRepos);
  // The pictures, in one read: a green pull's row leads with its preview.
  const repoIds = [...new Set(candidates.map((c) => c.repo.id))];
  const records = appsForRepos(db, repoIds);
  const looks = looksForApps(
    db,
    [...records.values()].map((r) => r.id),
  );
  const pictureOf = (repo: Repo, pull: Pull): string | undefined => {
    const record = records.get(repo.id);
    if (record === undefined) return undefined;
    const env = previewEnv(pull.number);
    const look = thumbLook(
      ctx,
      repo,
      record,
      looks.filter((l) => l.appId === record.id && l.env === env),
    );
    return (
      look && lookUrl(repoBase(repo), look)
    );
  };
  const worded = (c: Scored): Omit<Decision, "consequence" | "waiting"> => {
    if (c.kind === "assigned") {
      const thing = c.pull ?? c.issue!;
      return {
        kind: "assigned",
        id: `assigned:${thing.id}`,
        repo: c.repo,
        ...(c.pull === undefined ? { issue: c.issue } : { pull: c.pull }),
        who: c.who,
        says: c.why === undefined ? `"${thing.title}" is assigned to you.` : `"${thing.title}" was handed to you by the crew: ${c.why}`,
        short: c.why ?? `assigned to you · updated ${thing.updatedAt.slice(0, 10)}`,
        ...(c.why === undefined ? {} : { why: c.why }),
        ...(c.builder === undefined ? {} : { giveBack: c.builder }),
        ...(c.canLand === true ? { canLand: true } : {}),
      };
    }
    if (c.kind === "proposal" && c.proposal)
      return {
        kind: "proposal",
        id: `proposal:${c.proposal.id}`,
        repo: c.repo,
        proposal: c.proposal,
        who: c.who,
        says: `${c.who} proposes "${c.proposal.title}" (${issueTitles(c.proposal).length} issues). Approve opens them, Redirect hands your words to the planner, Later puts it aside.`,
        short: `proposes "${c.proposal.title}"`,
      };
    if (c.kind === "parked" && c.issue)
      return {
        kind: "parked",
        id: `parked:${c.issue.id}`,
        repo: c.repo,
        issue: c.issue,
        who: c.who,
        says: `Three runs on #${c.issue.number} failed or were declined within an hour, so the crew parked it. Say what to try and it starts again.`,
        short: `#${c.issue.number} parked after three failed runs`,
      };
    if (c.kind === "declined" && c.issue && c.decline)
      return {
        kind: "declined",
        id: `declined:${c.decline.runId}`,
        repo: c.repo,
        issue: c.issue,
        who: c.who,
        says: `The planner declined the direction: \u201c${c.decline.words}\u201d. It plans nothing more until you answer on #${c.issue.number}.`,
        short: `the planner declined the direction: \u201c${c.decline.words}\u201d`,
      };
    if (c.kind === "handover" && c.pull && c.handover)
      return {
        kind: "handover",
        id: `handover:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: `The reviewer asked for changes three times with no approval between, so the crew stopped. ${handoverLines(c.handover).join(" ")} Say what to try (or approve it on its page), or close it.`,
        short: `"${c.pull.title}" had three reviews asking for changes`,
        why: c.why,
        recommendation: c.recommendation,
        giveBack: c.builder,
      };
    if (c.kind === "waiting" && c.pull)
      return {
        kind: "waiting",
        id: `waiting:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: `"${c.pull.title}" is ${c.why ?? "waiting"}, and no person has acted on it. Ship it, say what to change, or close it.`,
        short: c.why ?? "waiting for a person",
        why: c.why,
        recommendation: c.recommendation,
      };
    if (c.kind === "stopped" && c.pull) {
      const tries = c.tries ?? 0;
      const stopped = c.stoppedByDecider ?? false;
      return {
        kind: "stopped",
        id: `stopped:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: stopped
          ? `${c.who}'s check failed and the crew's decider stopped rather than spend another run. Say what to try, or close it.`
          : `${c.who} tried ${tries + 1} times and the check still fails. The crew stopped here. Say what to try, or close it.`,
        short: stopped
          ? `the check failed; the decider stopped for you`
          : `${c.who} tried ${tries + 1} times; the check still fails`,
      };
    }
    if (c.kind === "review" && c.pull)
      return {
        kind: "review",
        id: `review:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: `${c.who}'s "${c.pull.title}" is green and waits for a review: ${reviewWhy(c.reviewWait, reviewerPaused(c.repo))}. An agent's change never ships unreviewed; ship it, or say what is off.`,
        short: `green; waits for a review — ${reviewWhy(c.reviewWait, reviewerPaused(c.repo))}`,
      };
    if (c.kind === "look" && c.pull) {
      const picture = pictureOf(c.repo, c.pull);
      const clause = testsClause(c.check ?? null);
      // The crew's own words say who finished it; a person's own change
      // gets the wording that is true of it — nobody "finished" it for
      // them, it is simply green and waiting.
      return {
        kind: "look",
        id: `look:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: c.authorIsAgent
          ? `${c.who} finished "${c.pull.title}" and the check is green${clause === "" ? "" : ` (${clause})`}. Look at the preview, then ship it or say what is off.`
          : `"${c.pull.title}" is green — ${clause === "" ? "" : `${clause}, `}ready for a look. Ship it, or say what is off.`,
        short: c.authorIsAgent
          ? `${c.who} finished it; the check is green${clause === "" ? "" : ` (${clause})`}`
          : `green — ${clause === "" ? "" : `${clause}, `}ready for a look`,
        ...(picture === undefined ? {} : { picture }),
      };
    }
    return {
      kind: "paused",
      id: `paused:${c.repo.id}`,
      repo: c.repo,
      who: "the crew",
      says: `${c.repo.name} reached its $${dollars(c.repo.autonomyCeilingUsd)} for today. The crew picks nothing more until 00:00 UTC. Raise the ceiling in settings to go on now.`,
      short: `at its $${dollars(c.repo.autonomyCeilingUsd)} ceiling until 00:00 UTC`,
    };
  };
  const previewOf = (c: Scored): string | undefined =>
    c.pull === undefined || !records.has(c.repo.id)
      ? undefined
      : `${repoBase(c.repo)}/app/pull-${c.pull.number}/open`;
  return candidates.map((c) => ({
    ...worded(c),
    preview: previewOf(c),
    consequence: c.consequence,
    waiting: c.waiting,
  }));
}

/** The id of the form a row's own button submits (see `decisionForm`). */
const askFormId = (d: Decision): string => `ask-${d.id}`;

/**
 * The form behind a row's landing button — its own post, exactly as it was.
 * It sits after the panel's form, because a form inside a form is not
 * HTML; the button reaches it by id.
 */
export function decisionForm(d: Decision, back?: string): Html | null {
  const pull = d.pull;
  const own = html`id="${askFormId(d)}" method="post" hidden`;
  if (d.kind === "parked")
    return html`<form ${own} action="/asks/decide">
      <input type="hidden" name="ask" value="${d.id}" />
    </form>`;
  if (d.kind === "proposal" && d.proposal) return proposalForms(d, back);
  if (d.kind === "assigned" && d.issue !== undefined)
    return html`${d.giveBack === undefined
      ? null
      : html`<form id="${askFormId(d)}-back" method="post" hidden action="/asks/give-back">
      <input type="hidden" name="ask" value="${d.id}" />${back === undefined ? null : html`<input type="hidden" name="back" value="${back}" />`}
    </form>`}<form ${own} action="${repoBase(d.repo)}/issues/${d.issue.number}/state">
      <input type="hidden" name="state" value="closed" />${back === undefined ? null : html`<input type="hidden" name="back" value="${back}" />`}
    </form>`;
  if (pull === undefined) return null;
  const base = repoBase(d.repo);
  const where = back === undefined ? null : html`<input type="hidden" name="back" value="${back}" />`;
  if (d.kind === "assigned")
    return html`${d.giveBack === undefined
      ? null
      : html`<form id="${askFormId(d)}-back" method="post" hidden action="/asks/give-back">
      <input type="hidden" name="ask" value="${d.id}" />${where}
    </form>`}${d.canLand !== true
      ? null
      : html`<form id="${askFormId(d)}-land" method="post" hidden action="${base}/pulls/${pull.number}/ship">
      <input type="hidden" name="pull" value="${pull.number}" />${where}
    </form>`}<form ${own} action="${base}/pulls/${pull.number}/state">
      <input type="hidden" name="state" value="closed" />${where}
    </form>`;
  if (d.kind === "handover" && d.giveBack !== undefined)
    return html`<form ${own} action="${base}/pulls/${pull.number}/state">
        <input type="hidden" name="state" value="closed" />${where}
      </form>
      <form id="${askFormId(d)}-back" method="post" hidden action="/asks/give-back">
        <input type="hidden" name="ask" value="${d.id}" />${where}
      </form>`;
  if (d.kind === "stopped" || d.kind === "handover")
    return html`<form ${own} action="${base}/pulls/${pull.number}/state">
      <input type="hidden" name="state" value="closed" />${where}
    </form>`;
  if (d.kind === "look" || d.kind === "review")
    return html`<form ${own} action="${base}/pulls/${pull.number}/ship">
      <input type="hidden" name="pull" value="${pull.number}" />${where}
    </form>`;
  if (d.kind === "waiting")
    return html`<form ${own} action="${base}/pulls/${pull.number}/ship">
        <input type="hidden" name="pull" value="${pull.number}" />${where}
      </form>
      <form id="${askFormId(d)}-close" method="post" hidden action="${base}/pulls/${pull.number}/state">
        <input type="hidden" name="state" value="closed" />${where}
      </form>`;
  return null;
}

/**
 * The actions on one ask, on one line: a button for what lands (submitting
 * the row's own form, `decisionForm`), links for what needs a look or a
 * word. Saying something to the crew happens on the change's own page,
 * where the conversation is — not in a box in a list.
 */
export function decisionActions(ctx: Ctx, d: Decision): Html {
  const { primary, others } = decisionButtons(ctx, d);
  return html`${primary} ${others}`;
}

/** An ask's actions in two parts: the one that decides, and the rest. */
export function decisionButtons(ctx: Ctx, d: Decision): { primary: Html; others: Html[] } {
  const base = repoBase(d.repo);
  const pull = d.pull;
  const preview = d.preview;
  if ((d.kind === "stopped" || d.kind === "handover") && pull)
    return {
      primary: btn("Tell them", {
        href: `${changeHref(base, pull.number)}#comment-body`,
        size: "sm",
        variant: "primary",
      }),
      others: [
        ...(d.kind === "handover" && d.giveBack !== undefined
          ? [btn("Give back to the crew", { size: "sm", form: `${askFormId(d)}-back` })]
          : []),
        btn("Close", { size: "sm", form: askFormId(d) }),
        btn("See", { href: changeHref(base, pull.number), size: "sm" }),
      ],
    };
  if ((d.kind === "look" || d.kind === "review") && pull)
    return {
      primary: btn("Ship", { size: "sm", form: askFormId(d), variant: "primary" }),
      others: [
        ...(preview === undefined ? [] : [btn("Preview", { href: preview, size: "sm" })]),
        btn("Not like this", {
          href: `${changeHref(base, pull.number)}#comment-body`,
          size: "sm",
        }),
      ],
    };
  if (d.kind === "waiting" && pull)
    return {
      primary: btn("Ship", { size: "sm", form: askFormId(d), variant: "primary" }),
      others: [
        btn("Say what to change", {
          href: `${changeHref(base, pull.number)}#comment-body`,
          size: "sm",
        }),
        btn("Close", { size: "sm", form: `${askFormId(d)}-close` }),
      ],
    };
  if (d.kind === "assigned" && (d.pull ?? d.issue)) {
    const open = btn("Open", {
      href: pull ? changeHref(base, pull.number) : `${base}/issues/${d.issue!.number}`,
      size: "sm",
    });
    const close = btn("Close", { size: "sm", form: askFormId(d) });
    const give = d.giveBack === undefined ? [] : [btn("Give to the crew", { size: "sm", form: `${askFormId(d)}-back`, variant: "primary" as const })];
    const land = d.canLand === true ? [btn("Land", { size: "sm", form: `${askFormId(d)}-land` })] : [];
    // One accent per card: only the first action is primary.
    const [first, ...rest] = [...give, ...land, close];
    return { primary: first!, others: [...rest, open] };
  }
  if (d.kind === "proposal" && d.proposal)
    return {
      primary: btn("Approve", { size: "sm", form: askFormId(d), variant: "primary" }),
      others: [btn("Later", { size: "sm", form: `${askFormId(d)}-later` })],
    };
  if (d.kind === "declined" && d.issue)
    return {
      primary: btn("Answer", {
        href: `${base}/issues/${d.issue.number}#comment-body`,
        size: "sm",
        variant: "primary",
      }),
      others: [],
    };
  if (d.kind === "parked" && d.issue)
    return {
      primary: btn("Tell them", {
        href: `${base}/issues/${d.issue.number}#comment-body`,
        size: "sm",
        variant: "primary",
      }),
      // Only where a decider is there to answer.
      others:
        ctx.app.config.decider === undefined
          ? []
          : [btn("Let the decider", { size: "sm", form: askFormId(d) })],
    };
  return {
    primary: btn("Settings", { href: `${base}/settings/autonomy`, size: "sm" }),
    others: [],
  };
}

/**
 * The forms behind a proposal card: Approve, Later and Redirect, each one
 * POST to `/asks/proposal/:id/<verb>` that lands back on the page it came
 * from. They sit apart from the card's own form, as forms do not nest.
 */
function proposalForms(d: Decision, back?: string): Html {
  const id = askFormId(d);
  const post = (verb: string) => `/asks/proposal/${d.proposal!.id}/${verb}`;
  const where = back === undefined ? null : html`<input type="hidden" name="back" value="${back}" />`;
  return html`<form id="${id}" method="post" action="${post("approve")}" hidden data-now="Approved" data-now-once>${where}</form>
    <form id="${id}-later" method="post" action="${post("later")}" hidden>${where}</form>`;
}
