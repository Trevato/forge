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
  canAdmin,
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
import { FOLLOW_SWITCH_LABELS, followModeWords } from "../../actions/follow_words.ts";
import type { ForkFollowMode } from "../../core/fork_follow.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { convergeWords, followModeOf, takeOrTell, takeWords } from "../../actions/follow.ts";
import { FOLLOW_WORD, FOLLOWS_NOTHING, proposeRefusalWords } from "../../actions/follow_words.ts";
import { openProposal, proposeUpstream } from "../../actions/upstream.ts";
import { proposesViaFork } from "../../origins/fork-route.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashOrJson } from "../layout.ts";
import { badge, btn, icon, row, type Tone } from "../ui.ts";
import { disconnectedOn } from "./frozen.ts";

/**
 * The family as a tree: nested lists, so the nesting a sighted reader sees
 * as indentation is the nesting a screen reader announces, and a phone
 * never has to scroll sideways to follow it. The repository being looked at
 * is marked "you are here", the viewer's other forks say "you", and every
 * fork carries its standing against its own parent.
 */
export function lineageCard(lineage: Lineage, hereId: string, viewerId?: string): Html {
  const node = (n: LineageNode, depth: number): Html => {
    const here = n.repo.id === hereId;
    const trail = [
      here ? badge("you are here", { variant: "outline" }) : null,
      // The viewer's own forks say "you" in words. aria-current stays on the one row being looked at.
      !here && viewerId !== undefined && n.repo.ownerId === viewerId ? badge("you", { variant: "outline" }) : null,
      n.mode === undefined ? null : html`<span class="muted small">${FOLLOW_WORD[n.mode]}</span>`,
      n.relation === undefined ? null : relationBadge(n.relation),
    ].filter((t): t is Html => t !== null);
    return row({
      href: `/${n.repo.ownerName}/${n.repo.name}`,
      nav: true,
      current: here,
      lead: icon(depth === 0 ? "repo" : "fork"),
      title: `${n.repo.ownerName}/${n.repo.name}`,
      ...(n.repo.description === "" ? {} : { meta: html`${n.repo.description}` }),
      ...(trail.length === 0 ? {} : { trail: html`${trail}` }),
      children: n.children.map((c) => node(c, depth + 1)),
    });
  };
  return html`<section class="settings-block">
    <ul class="list" aria-label="Forks, by who follows whom">
      ${node(lineage.root, 0)}
    </ul>
    ${when(
      lineage.truncated,
      () =>
        html`<p class="muted small">
          A large family: the newest and deepest forks are left out here; each
          fork's own page shows where it stands.
        </p>`,
    )}
  </section>`;
}

export interface Following {
  readonly relation: ForkRelation;
  readonly converge: Converge | undefined;
  /** The parent forge's releases, when this forge names a parent forge. */
  readonly releases: { url: string; view: ParentReleases } | undefined;
  /** How this repository follows its parent (`followModeOf`). */
  readonly mode: ForkFollowMode;
}

/** Everything the card needs, for a repo that follows something. */
export async function followingOf(
  ctx: Ctx,
  repo: Repo,
): Promise<Following | undefined> {
  if (repo.forkParentId === null) return undefined;
  if (archivedParent(ctx, repo) !== undefined) return undefined;
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
  return { relation, converge, releases, mode: await followModeOf(ctx.app, repo) };
}

/** The parent, when the viewer may read it and an admin has archived it. */
function archivedParent(ctx: Ctx, repo: Repo): Repo | undefined {
  const parent = forkParentFor(ctx.app.db, repo, ctx.auth.user);
  return parent?.archivedAt === null ? undefined : parent;
}

/**
 * In place of the Following card, when the parent is archived (#7452): one
 * quiet line. A frozen parent's "N ahead" reads as unshipped work, and there
 * is nothing to take from it or offer it, so no count and no button.
 */
export function archivedParentLine(ctx: Ctx, repo: Repo): Html | null {
  const parent = archivedParent(ctx, repo);
  if (parent === undefined) return null;
  return html`<p class="mt small muted" data-archived-parent>
    ${icon("fork")} forked from
    <a href="/${parent.ownerName}/${parent.name}">${parent.ownerName}/${parent.name}</a>
    (archived)${canAdmin(ctx.app.db, repo, ctx.auth.user)
      ? html` · <a href="${repoBase(repo)}/settings/danger#detach">detach from it</a>`
      : null}
  </p>`;
}

/**
 * "N releases behind <parent>", each with its name and link; or, when the
 * parent cannot be read, that it cannot and how old the last copy is.
 * Every field comes from another server and is escaped by `html`.
 */
export function releasesBlock(
  parentUrl: string,
  releases: ParentReleases,
): { sentence: Html; links: Html[] } {
  const host = new URL(parentUrl).host;
  const version = running().version;
  const { releases: news } = parentForgeOf(parentUrl, releases, version);
  return {
    sentence: html`<p>${releasesSentence(releases, version, host)}</p>`,
    links: news.map((r) => row({ href: r.url, title: r.name })),
  };
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
            ? [`diverged · ${relation.ahead} ahead · ${relation.behind} behind · merges cleanly`, "attn"]
            : [`diverged · ${relation.ahead} ahead · ${relation.behind} behind`, "attn"];
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
  /** `bare` drops the card's margin; `family: false` drops the link to the forks page, for the forks page itself. */
  o: { bare?: boolean; family?: boolean } = {},
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
            ${proposesViaFork(ctx.app, parent)
              ? btn("Propose via your fork", {
                  size: "sm",
                  type: "submit",
                  icon: "fork",
                  title: `Your account can only read ${parent.ownerName}/${parent.name}'s origin, or its operator protects it: the change goes to your own fork there, and the pull opens from it`,
                })
              : btn("Offer this change", {
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
          : // Only a writer can do either; a visitor is not told to.
            writer
            ? html`Nobody is on the crew to converge it: add someone under
                <a href="${base}/settings/crew">Settings → Crew</a>, or merge
                <span class="mono">refs/following/${parent.defaultBranch}</span>
                by hand.`
            : null
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

  const head = html`${icon("fork")} following
    <a href="/${parent.ownerName}/${parent.name}">${parentName}</a>
    ${converge?.kind === "proposed"
      ? badge("proposal ready", { tone: "merged" })
      : converge?.kind === "working"
        ? badge("converging", { tone: "attn" })
        : relationBadge(relation)}`;
  // Sentences wrap in plain paragraphs: a row title is one clipped line,
  // and these carry the links a person needs.
  const prose: Html[] = [
    html`<p>
      ${parent.detached === null
        ? relationSentence(relation)
        : html`${parentName} is frozen: its origin
            ${disconnectedOn(parent.detached)}, so what is here may be behind.
            <a href="/${parent.ownerName}/${parent.name}#frozen"
              >Reconnect it.</a
            >`}
    </p>`,
  ];
  const rows: Html[] = [];
  if (following.releases !== undefined) {
    const block = releasesBlock(following.releases.url, following.releases.view);
    prose.push(block.sentence);
    rows.push(...block.links);
  }
  if (parent.detached === null && relation.action !== "none")
    prose.push(html`<p class="muted small">${relation.words}</p>`);
  if (foot !== null) prose.push(html`<p class="muted small">${foot}</p>`);
  const words = followModeWords(following.mode, parentName);
  prose.push(
    html`<p data-follow-mode="${following.mode}">
      <strong>${words.line}</strong>.
      ${canAdmin(ctx.app.db, repo, ctx.auth.user) && writer
        ? words.others.map((m) =>
            btn(FOLLOW_SWITCH_LABELS[m], {
              href: `/-/confirm?to=${encodeURIComponent(`${base}/following/mode/${m}`)}`,
              size: "sm",
            }),
          )
        : null}
    </p>`,
  );
  if (followers > 0 && o.family !== false)
    rows.push(
      row({
        href: `${base}/forks`,
        title: `${followers === 1 ? "One fork follows" : `${followers} forks follow`} this one.`,
      }),
    );
  return html`<section
    class="settings-block${o.bare === true ? " bare" : " mt"}"
    id="following"
  >
    <div class="bar"><h2>${head}</h2></div>
    <div class="stack">${prose}</div>
    ${when(
      rows.length > 0,
      () => html`<ul class="list">
        ${rows}
      </ul>`,
    )}
    ${when(
      actions.length > 0,
      () => html`<div class="bar mt">${actions}</div>`,
    )}
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
  const parent = forkParentFor(ctx.app.db, repo, ctx.auth.user);
  if (parent === undefined)
    return flashOrJson(ctx, base, {
      tone: "danger",
      message: FOLLOWS_NOTHING,
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
        message: proposeRefusalWords(e, parentName),
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
  return flashOrJson(ctx, base, takeWords(took, repo, parent));
}
