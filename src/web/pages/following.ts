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
  type ForkRelation,
} from "../../actions/forks.ts";
import { listCrewRoles } from "../../core/agents.ts";
import {
  canRead,
  canWrite,
  forkParentFor,
  type Repo,
  visibleForks,
} from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  convergeFork,
  convergeState,
  type Converge,
} from "../../crew/converge.ts";
import type { Lineage, LineageNode } from "../../core/following.ts";
import {
  parentReleases,
  parentForgeOf,
  releasesSentence,
  type ParentReleases,
} from "../../core/parent_releases.ts";
import { running } from "../../kernel/version.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { convergeWords, takeOrTell } from "../../actions/follow.ts";
import { openProposal, proposeUpstream } from "../../actions/upstream.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashOrJson } from "../layout.ts";
import { badge, btn, card, icon, type Tone } from "../ui.ts";
import { disconnectedOn } from "./frozen.ts";

/**
 * The family as a tree: nested lists, so the nesting a sighted reader sees
 * as indentation is the nesting a screen reader announces, and a phone
 * never has to scroll sideways to follow it. The repository being looked at
 * is marked, and every fork carries its standing against its own parent.
 */
export function lineageCard(lineage: Lineage, hereId: string): Html {
  const node = (n: LineageNode, depth: number): Html => {
    const here = n.repo.id === hereId;
    const name = `${n.repo.ownerName}/${n.repo.name}`;
    return html`<li>
      <a
        href="/${n.repo.ownerName}/${n.repo.name}"
        class="row"
        data-nav
        tabindex="-1"
        ${here ? raw('aria-current="page"') : null}
      >
        <span class="row-lead">${icon(depth === 0 ? "repo" : "fork")}</span>
        <span class="row-main">
          <span class="row-title"
            >${name}${here
              ? html` <span class="lineage-here">you are here</span>`
              : null}</span
          >
          ${n.repo.description === ""
            ? null
            : html`<span class="row-meta">${n.repo.description}</span>`}
        </span>
        ${n.relation === undefined
          ? null
          : html`<span class="row-trail">${relationBadge(n.relation)}</span>`}
      </a>
      ${n.children.length === 0
        ? null
        : html`<ul class="lineage-children">
            ${n.children.map((c) => node(c, depth + 1))}
          </ul>`}
    </li>`;
  };
  return card(
    html`<ul class="list lineage" aria-label="Forks, by who follows whom">
        ${node(lineage.root, 0)}
      </ul>
      ${when(
        lineage.truncated,
        () =>
          html`<p class="muted small card-body">
            A large family: the newest and deepest forks are left out here; each
            fork's own page shows where it stands.
          </p>`,
      )}`,
    { pad: false },
  );
}

export interface Following {
  readonly relation: ForkRelation;
  readonly converge: Converge | undefined;
  /** The parent forge's releases, when this forge names a parent forge. */
  readonly releases: { url: string; view: ParentReleases } | undefined;
}

/** Everything the card needs, for a repo that follows something. */
export async function followingOf(
  ctx: Ctx,
  repo: Repo,
): Promise<Following | undefined> {
  if (repo.forkParentId === null) return undefined;
  const relation = await relationOf(ctx.app, ctx.auth.user, repo);
  if (relation === undefined) return undefined;
  // A parent the viewer may not read is not named here at all.
  if (!canRead(ctx.app.db, relation.parent, ctx.auth.user)) return undefined;
  const converge =
    relation.state === "diverged" && !relation.clean
      ? convergeState(ctx.app, repo, relation.parent)
      : undefined;
  const { parentUrl } = ctx.app.config;
  const releases =
    parentUrl === undefined
      ? undefined
      : {
          url: parentUrl,
          view: parentReleases(ctx.app.config.dataDir, parentUrl, {
            loopback: ctx.app.config.parentLoopback === true,
          }),
        };
  return { relation, converge, releases };
}

/**
 * "N releases behind <parent>", each with its name and link; or, when the
 * parent cannot be read, that it cannot and how old the last copy is.
 * Every field comes from another server and is escaped by `html`.
 */
export function releasesBlock(parentUrl: string, releases: ParentReleases): Html {
  const host = new URL(parentUrl).host;
  const version = running().version;
  const { releases: news } = parentForgeOf(parentUrl, releases, version);
  return html`<div class="following-releases">
    <p class="following-sentence">
      ${releasesSentence(releases, version, host)}
    </p>
    ${news.length === 0
      ? null
      : html`<ul class="list">
          ${news.map(
            (r) =>
              html`<li>
                <a href="${r.url}" rel="noopener noreferrer">${r.name}</a>
              </li>`,
          )}
        </ul>`}
  </div>`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The relationship as a badge: for a fork list, a header, a row. A parent
 * whose origin was disconnected is frozen, and "in step" with something
 * frozen says nothing about upstream — so it is never said (#1090).
 */
export function relationBadge(relation: ForkRelation): Html {
  if (relation.parent.detached !== null)
    return badge("parent frozen", { tone: "attn" });
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

/**
 * The sentence a person reads first. Behind a frozen parent, ahead and
 * behind are counted against where it froze, not against its upstream, so
 * the sentence says that instead of a count that only looks like news.
 */
export function relationSentence(relation: ForkRelation): string {
  const parent = `${relation.parent.ownerName}/${relation.parent.name}`;
  const frozen = relation.parent.detached;
  if (frozen !== null)
    return `${parent} is frozen: its origin was disconnected${frozen.detachedAt === null ? "" : ` on ${frozen.detachedAt.slice(0, 10)}`}, so what is here may be behind. Reconnect it.`;
  switch (relation.state) {
    case "synced":
      return `Everything here is up to date with ${parent}.`;
    case "behind":
      return `${plural(relation.behind, "commit")} behind ${parent}, nothing of your own.`;
    case "ahead":
      return `${plural(relation.ahead, "commit")} of your own; ${parent} hasn't moved.`;
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
  const followers = visibleForks(ctx.app.db, repo.id, ctx.auth.user).length;

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

  // The fork's own work, offered upstream in one click: the words come
  // from what landed here, so nothing waits on the crew.
  if (writer && relation.ahead > 0) {
    const proposal = openProposal(ctx.app, repo, parent);
    actions.push(
      proposal === undefined
        ? html`<form method="post" action="${base}/following">
            <input type="hidden" name="do" value="propose" />
            ${btn("Propose upstream", {
              size: "sm",
              type: "submit",
              icon: "merge",
            })}
          </form>`
        : btn("See the upstream proposal", {
            size: "sm",
            href: `/${parent.ownerName}/${parent.name}/pulls/${proposal.number}`,
          }),
    );
  }

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
      <p class="following-sentence">
        ${parent.detached === null
          ? relationSentence(relation)
          : html`${parentName} is frozen: its origin
              ${disconnectedOn(parent.detached)}, so what is here may be behind.
              <a href="/${parent.ownerName}/${parent.name}#frozen"
                >Reconnect it.</a
              >`}
      </p>
      ${following.releases === undefined
        ? null
        : releasesBlock(following.releases.url, following.releases.view)}
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
 * What taking updates says when there was nothing to take. "Up to date"
 * only of a parent that is itself up to date: a frozen one may be far
 * behind its own upstream, and the take only knows the frozen copy.
 */
export function nothingNew(parent: Repo): string {
  const name = `${parent.ownerName}/${parent.name}`;
  return parent.detached === null
    ? `Already up to date with ${name}.`
    : `Nothing new from ${name}, which is frozen: its origin was disconnected, so upstream may have moved. Reconnect it.`;
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
  const parent = forkParentFor(ctx.app.db, repo, ctx.auth.user);
  if (parent === undefined)
    return flashOrJson(ctx, base, {
      tone: "danger",
      message: "This repository follows nothing.",
    });
  const parentName = `${parent.ownerName}/${parent.name}`;

  if (field(form, "do") === "converge") {
    if (!canWrite(ctx.app.db, repo, ctx.auth.user))
      return flashOrJson(ctx, base, {
        tone: "danger",
        message: "Only a writer can ask the crew to converge.",
      });
    const outcome = await convergeFork(ctx.app, repo, parent, ctx.auth.user);
    return flashOrJson(ctx, base, convergeWords(outcome, parentName));
  }
  if (field(form, "do") === "propose") {
    const proposed = await proposeUpstream(ctx.app, ctx.auth.user, repo);
    if (!proposed.ok) {
      const e = proposed.error;
      return flashOrJson(ctx, base, {
        tone: "danger",
        message:
          e === "not_a_fork"
            ? "This repository follows nothing."
            : e === "nothing_to_propose"
              ? `Nothing here is ahead of ${parentName}.`
              : typeof e === "string"
                ? "You need write access to propose from here."
                : `${parentName} did not take the proposal: ${e.reason}.`,
      });
    }
    const { pull, opened, changes } = proposed.value;
    return flashOrJson(
      ctx,
      `/${parent.ownerName}/${parent.name}/pulls/${pull.number}`,
      {
        message: opened
          ? `Proposed to ${parentName}: ${changes === 1 ? "one change" : changes === 0 ? "the commits ahead" : `${changes} changes`}, as #${pull.number}.`
          : `Already proposed to ${parentName} as #${pull.number}.`,
      },
    );
  }

  const took = await takeOrTell(ctx.app, ctx.auth.user, repo);
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
    // A conflict is a tell for the crew (`actions/follow.ts`).
    if (e.kind === "conflict") {
      const files = `${e.files.length === 1 ? "One file needs" : `${e.files.length} files need`} a decision (${e.files.join(", ")})`;
      const words = "converge" in e ? convergeWords(e.converge, parentName) : { message: "" };
      return flashOrJson(ctx, base, { tone: "danger", message: `${files}. ${words.message}` });
    }
    return flashOrJson(ctx, base, {
      tone: "danger",
      message:
        e.kind === "moved"
            ? "Something moved while this was read; try again."
            : `Git could not take the updates: ${e.message}`,
    });
  }
  return flashOrJson(ctx, base, {
    message: !took.value.updated
      ? nothingNew(parent)
      : took.value.merged
        ? `Took ${parentName}'s updates: merged into ${repo.defaultBranch} at ${took.value.to.slice(0, 7)}.`
        : `Took ${parentName}'s updates: ${repo.defaultBranch} is at ${took.value.to.slice(0, 7)}.`,
  });
}
