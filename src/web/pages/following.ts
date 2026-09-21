/**
 * Where a fork stands against the repository it follows, in one sentence,
 * with the one thing to do about it. The relationship is read from git on
 * every view (`core/following.ts`); the crew's part, when both sides moved
 * and git cannot decide, is read from the fork's own issue and pull.
 *
 * Stale and diverged weigh differently on purpose: behind-only is a quiet
 * button that fast-forwards, a clean merge is the same button and a merge
 * commit, and a conflict never becomes a button that silently does nothing
 * — it becomes the crew's proposal, or an honest sentence about why not.
 */

import {
  relationOf,
  takeUpdates,
  type ForkRelation,
} from "../../actions/forks.ts";
import { listCrewRoles } from "../../core/agents.ts";
import {
  canWrite,
  getRepoById,
  listForks,
  type Repo,
} from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  convergeFork,
  convergeState,
  type Converge,
} from "../../crew/converge.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashOrJson } from "../layout.ts";
import { badge, btn, icon, type Tone } from "../ui.ts";

export interface Following {
  readonly relation: ForkRelation;
  readonly converge: Converge | undefined;
}

/** Everything the card needs, for a repo that follows something. */
export async function followingOf(
  ctx: Ctx,
  repo: Repo,
): Promise<Following | undefined> {
  if (repo.forkParentId === null) return undefined;
  const relation = await relationOf(ctx.app, ctx.auth.user, repo);
  if (relation === undefined) return undefined;
  const converge =
    relation.state === "diverged" && !relation.clean
      ? convergeState(ctx.app, repo, relation.parent)
      : undefined;
  return { relation, converge };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The relationship as a badge: for a fork list, a header, a row. */
export function relationBadge(relation: ForkRelation): Html {
  const [text, tone]: [string, Tone] =
    relation.state === "synced"
      ? ["in step", "success"]
      : relation.state === "behind"
        ? [`${relation.behind} behind`, "default"]
        : relation.state === "ahead"
          ? [`${relation.ahead} ahead`, "default"]
          : relation.clean
            ? ["diverged · merges cleanly", "attn"]
            : ["diverged", "attn"];
  return badge(text, { tone });
}

/** The sentence a person reads first. */
export function relationSentence(relation: ForkRelation): string {
  const parent = `${relation.parent.ownerName}/${relation.parent.name}`;
  switch (relation.state) {
    case "synced":
      return `In step with ${parent}.`;
    case "behind":
      return `${plural(relation.behind, "change")} behind ${parent}, nothing of your own.`;
    case "ahead":
      return `${plural(relation.ahead, "change")} of your own; ${parent} hasn't moved.`;
    case "diverged": {
      const both = `${relation.behind} behind and ${relation.ahead} of your own`;
      if (relation.clean) return `${both}; they merge cleanly.`;
      const n = relation.conflicts.length;
      return n === 0
        ? `${both}; git cannot merge them.`
        : `${both}; ${n === 1 ? "one file needs" : `${n} files need`} a decision: ${relation.conflicts.join(", ")}.`;
    }
  }
}

/**
 * The card on a fork's home. `studio` swaps nothing but the words for the
 * crew's part; the mechanics are one and the same.
 */
export function followingCard(
  ctx: Ctx,
  repo: Repo,
  following: Following,
): Html {
  const { relation, converge } = following;
  const parent = relation.parent;
  const parentName = `${parent.ownerName}/${parent.name}`;
  const base = repoBase(repo);
  const writer = canWrite(ctx.app.db, repo, ctx.auth.user);
  const crew = listCrewRoles(ctx.app.db, repo.id).some(
    (c) => c.role === "builder",
  );
  const followers = listForks(ctx.app.db, repo.id).length;

  const canTake =
    relation.state === "behind" ||
    (relation.state === "diverged" && relation.clean);
  const conflict = relation.state === "diverged" && !relation.clean;

  const actions: Html[] = [];
  if (writer && canTake)
    actions.push(
      html`<form method="post" action="${base}/following">
        <input type="hidden" name="do" value="take" />
        ${btn("Take updates", {
          size: "sm",
          type: "submit",
          variant: "primary",
        })}
      </form>`,
    );
  if (writer && conflict && converge === undefined && crew)
    actions.push(
      html`<form method="post" action="${base}/following">
        <input type="hidden" name="do" value="converge" />
        ${btn("Converge with the crew", {
          size: "sm",
          type: "submit",
          variant: "primary",
        })}
      </form>`,
    );
  if (converge?.kind === "proposed")
    actions.push(
      btn("Look at the proposal", {
        size: "sm",
        href: `${base}/pulls/${converge.pull.number}`,
        variant: "primary",
      }),
    );

  const foot: Html | null =
    converge === undefined
      ? conflict
        ? crew
          ? writer
            ? null
            : html`A writer can ask the crew to converge it.`
          : html`Nobody is on the crew to converge it: add someone under
              <a href="${base}/settings/crew">Settings → Crew</a>, or merge
              <span class="mono">refs/following/${parent.defaultBranch}</span>
              by hand.`
        : null
      : converge.kind === "working"
        ? html`${converge.agent === undefined
              ? "The crew"
              : converge.agent.user.username}
            is converging it on
            <a href="${base}/issues/${converge.issue.number}"
              >#${converge.issue.number}</a
            >.`
        : converge.kind === "proposed"
          ? html`The crew's proposal is pull
              <a href="${base}/pulls/${converge.pull.number}"
                >#${converge.pull.number}</a
              >${repo.autonomy === "autonomous"
                ? "; it lands on its own when green."
                : "; it waits for your look."}`
          : converge.kind === "parked"
            ? html`The crew tried its limit on
                <a href="${base}/issues/${converge.issue.number}"
                  >#${converge.issue.number}</a
                >; say there what to do.`
            : null;

  return html`<section class="card following" id="following">
    <div class="card-body">
      <div class="following-head">
        <span class="following-eyebrow"
          >${icon("fork")} following
          <a href="/${parent.ownerName}/${parent.name}">${parentName}</a></span
        >
        ${converge?.kind === "proposed"
          ? badge("proposal ready", { tone: "merged" })
          : converge?.kind === "working"
            ? badge("converging", { tone: "attn" })
            : relationBadge(relation)}
      </div>
      <p class="following-sentence">${relationSentence(relation)}</p>
      ${when(
        actions.length > 0,
        () => html`<div class="following-actions">${actions}</div>`,
      )}
      ${when(foot, (f) => html`<p class="muted small following-foot">${f}</p>`)}
      ${when(
        followers > 0,
        () =>
          html`<p class="muted small following-foot">
            <a href="${base}/forks"
              >${followers === 1
                ? "One fork follows"
                : `${followers} forks follow`}
              this one.</a
            >
          </p>`,
      )}
    </div>
  </section>`;
}

/**
 * POST /:owner/:name/following  { do: take | converge }
 * One form, two verbs: take what git can take, or hand the rest to the crew.
 */
export async function followingSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const parent =
    repo.forkParentId === null
      ? undefined
      : getRepoById(ctx.app.db, repo.forkParentId);
  if (parent === undefined)
    return flashOrJson(ctx, base, {
      tone: "danger",
      message: "This repository follows nothing.",
    });
  const parentName = `${parent.ownerName}/${parent.name}`;

  if (field(form, "do") === "converge") {
    const outcome = await convergeFork(ctx.app, repo, parent, ctx.auth.user);
    return flashOrJson(ctx, base, convergeWords(outcome, parentName));
  }

  const took = await takeUpdates(ctx.app, ctx.auth.user, repo);
  if (!took.ok) {
    const e = took.error;
    if (typeof e === "string")
      return flashOrJson(ctx, base, {
        tone: "danger",
        message:
          e === "not_a_fork"
            ? "This repository follows nothing."
            : "You need write access to take updates here.",
      });
    return flashOrJson(ctx, base, {
      tone: "danger",
      message:
        e.kind === "conflict"
          ? `${e.files.length === 1 ? "One file needs" : `${e.files.length} files need`} a decision (${e.files.join(", ")}); the crew can converge it.`
          : e.kind === "moved"
            ? "Something moved while this was read; try again."
            : `Git could not take the updates: ${e.message}`,
    });
  }
  return flashOrJson(ctx, base, {
    message: !took.value.updated
      ? `Already up to date with ${parentName}.`
      : took.value.merged
        ? `Took ${parentName}'s updates: merged into ${repo.defaultBranch} at ${took.value.to.slice(0, 7)}.`
        : `Took ${parentName}'s updates: ${repo.defaultBranch} is at ${took.value.to.slice(0, 7)}.`,
  });
}

function convergeWords(
  outcome: Converge,
  parentName: string,
): { tone?: "danger"; message: string } {
  switch (outcome.kind) {
    case "queued":
      return {
        message: `${outcome.agent.user.username} is converging with ${parentName} on #${outcome.issue.number}; the proposal comes back as a pull.`,
      };
    case "working":
      return {
        message: `The crew is already converging on #${outcome.issue.number}.`,
      };
    case "proposed":
      return {
        message: `The crew's proposal is already open: pull #${outcome.pull.number}.`,
      };
    case "parked":
      return {
        tone: "danger",
        message: `The crew tried its limit on #${outcome.issue.number}; say there what to do.`,
      };
    case "nothing":
      return {
        message:
          outcome.relation?.state === "diverged"
            ? "They merge cleanly; Take updates does it without the crew."
            : "Nothing to converge.",
      };
    case "no_crew":
      return {
        tone: "danger",
        message:
          "Nobody is on the crew here; add someone under Settings → Crew.",
      };
    case "nobody":
      return {
        tone: "danger",
        message: "Nobody can open the converge issue here.",
      };
    case "ceiling":
      return {
        tone: "danger",
        message: "The crew is at today's ceiling; it converges tomorrow.",
      };
  }
}
