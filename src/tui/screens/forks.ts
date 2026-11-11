/**
 * A repository's forks, ranked: the same order and words as the forks page
 * (`actions/forks.ts` decides both), so the best of the tree rises here too.
 * Forks that are ahead come first, with the one that has the most to offer on
 * top; those with nothing new follow under their count. A fork's own parent
 * leads, read as MCP `following` reads it (`relationOf`, `convergeState`).
 * On a fork behind its parent, a person who writes it takes the parent's
 * updates with `t` after a confirm — `takeOrTell`, as MCP `take_updates` —
 * and a conflict's converge issue is the line Enter then opens.
 */

import {
  driftWords,
  nothingNewHeading,
  rankedForksOf,
  MAX_RANKED_FORKS,
  relationOf,
  type ForkRanking,
  type ForkRelation,
} from "../../actions/forks.ts";
import { followModeWords } from "../../actions/follow_words.ts";
import { FOLLOW_MODE_REFUSALS, convergeWords, followModeOf, followStanding, followModeSaid, setFollowMode, takeOrTell, takeWords } from "../../actions/follow.ts";
import { FOLLOWS_NOTHING, proposeRefusalWords } from "../../actions/follow_words.ts";
import { openProposal, proposeUpstream } from "../../actions/upstream.ts";
import type { Pull } from "../../core/pulls.ts";
import { convergeState, type Converge } from "../../crew/converge.ts";
import { FORK_FOLLOW_MODES, type ForkFollowMode } from "../../core/fork_follow.ts";
import { canAdmin, canRead, canWrite, forkTree, listForks, type ForkNode, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";
import { repoScreen } from "./workspace.ts";
import { ListState, confirmScreen, drawList, plural, runAsync, type ListRow } from "./common.ts";
import { pullScreen } from "./pull.ts";

/** One line of the screen; `issue` is a converge issue on the fork, which Enter opens. */
export interface ForkRow {
  repo: Repo;
  name: string;
  words: string;
  heading: string;
  issue?: number;
}

/** The rows the screen draws, in order: pure so a test reads them without a terminal. */
export function forkRows(
  ranked: ForkRanking,
  tree: readonly ForkNode[] = [],
): ForkRow[] {
  const below = new Map(tree.map((n) => [n.repo.id, n.forks]));
  const row = (f: ForkRanking["offering"][number], heading: string) => [
    {
      repo: f.fork,
      name: `${f.fork.ownerName}/${f.fork.name}`,
      words: ranked.archived ? "" : driftWords(f.drift),
      heading,
    },
    ...(below.get(f.fork.id) ?? []).map((n) => ({
      repo: n.repo,
      name: `  ${n.repo.ownerName}/${n.repo.name}`,
      words: n.deeper === 0 ? "" : `and ${n.deeper} more fork${n.deeper === 1 ? "" : "s"} below`,
      heading: "",
    })),
  ];
  return [
    ...ranked.offering.flatMap((f) => row(f, "")),
    ...ranked.nothingNew.flatMap((f, i) => row(f, i === 0 && !ranked.archived ? nothingNewHeading(ranked.nothingNew.length) : "")),
  ];
}

/**
 * What the repository follows, in at most two rows: where it stands against
 * its parent, in MCP `following`'s states and counts, and — only when the
 * crew has something in hand — what it is doing about it. A parent the
 * viewer may not read never reaches here: `relationOf` hides it.
 */
export function followingRows(
  relation: ForkRelation | undefined,
  converge: Converge | undefined,
  mode?: ForkFollowMode,
): ForkRow[] {
  if (relation === undefined) return [];
  const { parent } = relation;
  const name = `${parent.ownerName}/${parent.name}`;
  const counts = `${relation.ahead} ahead · ${relation.behind} behind`;
  const words =
    parent.detached !== null
      ? "parent frozen"
      : relation.state === "synced"
        ? "in step"
        : relation.state === "diverged"
          ? `diverged · ${counts}${relation.clean ? " · merges cleanly" : ""} · ${relation.action}`
          : `${relation.state} · ${counts}${relation.action === "none" ? "" : ` · ${relation.action}`}`;
  return [
    {
      repo: parent,
      name: `follows ${name}`,
      words: mode === undefined ? words : `${words} · ${followModeWords(mode, name).line}`,
      heading: "",
    },
    ...(converge === undefined
      ? []
      : [
          {
            repo: parent,
            name: `  ${convergeWords(converge, name).message}`,
            words: "",
            heading: "",
            ...("issue" in converge ? { issue: converge.issue.number } : {}),
          },
        ]),
  ];
}

/**
 * What `t` would do, or undefined when it is not offered: only on a fork
 * behind a parent that is not frozen, and only to a person who writes it.
 * Agents take updates through MCP `take_updates`, not a keypress.
 */
export function takeOffer(
  relation: ForkRelation | undefined,
  writer: boolean,
  person: boolean,
): string | undefined {
  if (relation === undefined || !writer || !person) return undefined;
  if (relation.behind === 0 || relation.parent.detached !== null) return undefined;
  const { parent, behind, ahead } = relation;
  const name = `${parent.ownerName}/${parent.name}`;
  const commits = plural(behind, "commit");
  if (ahead === 0) return `Fast-forward to ${name}: ${commits}.`;
  if (relation.clean) return `Merge ${commits} from ${name}; your ${plural(ahead, "commit")} stay.`;
  return `Both sides changed ${relation.conflicts.join(", ")}: the crew is told on a converge issue.`;
}

export function forksScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let ranked: ForkRanking | undefined;
  let tree: ForkNode[] = [];
  let following: ForkRow[] = [];
  let relation: ForkRelation | undefined;
  let offer: string | undefined;
  let open: Pull | undefined;
  let mode: ForkFollowMode | undefined;
  /** The one plain line the page and MCP say: how this fork follows, and when it last took. */
  let standing: string | undefined;
  const state = new ListState();
  /** Only a person who writes to a fork may propose its work upstream. */
  const mayPropose = () => f.user !== undefined && f.user.kind !== "agent" && canWrite(f.db, repo, f.user);
  const parentName = () =>
    relation === undefined ? "" : `${relation.parent.ownerName}/${relation.parent.name}`;
  const openIt = (pull: Pull) => {
    if (relation !== undefined) ctx.push(pullScreen(f, ctx, local(f, relation.parent), pull.number));
  };
  const propose = () => {
    if (relation === undefined) return ctx.toast(FOLLOWS_NOTHING, "danger");
    if (open !== undefined) return openIt(open);
    const name = parentName();
    if (relation.ahead === 0) return ctx.toast(proposeRefusalWords("nothing_to_propose", name), "danger");
    ctx.push(
      confirmScreen(ctx, self, {
        title: "Propose upstream",
        body: [`${plural(relation.ahead, "commit")} ahead would go to ${name} as one pull.`],
        actions: [{ label: "Cancel", variant: "ghost" }, { label: "Propose" }],
        onChoose: (i) => {
          if (i !== 1) return;
          runAsync(ctx, async () => {
            const made = await proposeUpstream(f.app, f.user, repo);
            if (!made.ok) return ctx.toast(proposeRefusalWords(made.error, name), "danger");
            const { pull, opened, changes } = made.value;
            open = pull;
            ctx.toast(
              opened
                ? `Proposed to ${name}: ${changes === 1 ? "one change" : changes === 0 ? "the commits ahead" : `${changes} changes`}, as #${pull.number}.`
                : `Already proposed to ${name} as #${pull.number}.`,
              "success",
            );
            ctx.invalidate();
          });
        },
      }),
    );
  };
  const rows = (): ForkRow[] => [
    ...(open === undefined || relation === undefined ? [] : [openRow(open, relation.parent)]),
    ...following,
    ...(ranked === undefined ? [] : forkRows(ranked, tree)),
  ];
  const read = async (): Promise<void> => {
    const forks = listForks(f.db, repo.id).filter((r) => canRead(f.db, r, f.user));
    ranked = await rankedForksOf(f.app, repo, forks);
    tree = forkTree(f.db, repo.id, f.user);
    relation = await relationOf(f.app, f.user, repo);
    open = relation === undefined ? undefined : openProposal(f.app, repo, relation.parent);
    offer = takeOffer(relation, canWrite(f.db, repo, f.user), f.user?.kind === "user");
    const converge =
      relation !== undefined && relation.state === "diverged" && !relation.clean
        ? convergeState(f.app, repo, relation.parent)
        : undefined;
    standing = await followStanding(f.app, repo, f.user);
    mode = relation === undefined ? undefined : await followModeOf(f.app, repo);
    following = followingRows(relation, converge, mode);
    ctx.invalidate();
  };
  const take = (): void => {
    const parent = relation?.parent;
    if (offer === undefined || parent === undefined) return;
    ctx.push(
      confirmScreen(ctx, self, {
        title: "Take updates",
        body: [offer],
        actions: [{ label: "Take updates" }, { label: "Cancel", variant: "ghost" }],
        yesNo: true,
        onChoose: (choice) => {
          if (choice !== 0) return;
          runAsync(ctx, async () => {
            const took = await takeOrTell(f.app, f.user, repo);
            const words = takeWords(took, repo, parent);
            await read();
            // The converge issue just opened or found is the line Enter opens.
            const e = took.ok ? undefined : took.error;
            if (typeof e === "object" && e.kind === "conflict" && "converge" in e && relation !== undefined) {
              following = followingRows(relation, e.converge, mode);
              state.index = following.length - 1;
            }
            ctx.toast(words.message, words.tone === "danger" ? "danger" : "default");
            ctx.invalidate();
          });
        },
      }),
    );
  };
  const canSetMode = (): boolean =>
    relation !== undefined && f.user?.kind === "user" && canAdmin(f.db, repo, f.user) && canWrite(f.db, repo, f.user);
  const self: Screen = {
    title: "Forks",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        ...(offer === undefined ? [] : [binding(["t"], "take updates")]),
        ...(relation !== undefined && mayPropose()
          ? [binding(["u"], open === undefined ? "propose upstream" : "open proposal")]
          : []),
        ...(canSetMode() ? [binding(["m"], "follow mode")] : []),
        binding(["esc"], "close"),
      ];
    },
    load: () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, line, body] = split(area, "v", [len(1), len(standing === undefined ? 0 : 1), fill(1)]);
      const list = rows();
      s.text(
        head!.x,
        head!.y,
        truncate(
          `${repo.ownerName}/${repo.name} · ${plural(ranked?.total ?? 0, "fork")}${ranked?.truncated ? ` · ranking the first ${MAX_RANKED_FORKS}` : ""}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (standing !== undefined) s.text(line!.x, line!.y, truncate(standing, line!.w), style(c.mutedFg, c.bg), line!.x + line!.w);
      if (list.length === 0) {
        emptyState(s, body!, c, {
          title: ranked === undefined ? "Reading…" : "No forks yet",
          body: "",
        });
        return;
      }
      drawList(
        s,
        body!,
        c,
        state,
        list.map((r): ListRow => ({
          title: r.name,
          secondary: r.heading,
          meta: r.words,
        })),
      );
    },
    key(e) {
      const list = rows();
      if (state.key(e, list.length)) return true;
      if (e.key === "enter") {
        const row = list[state.index];
        if (open !== undefined && state.index === 0) openIt(open);
        else if (row?.issue !== undefined) ctx.push(issueScreen(f, ctx, local(f, repo), row.issue));
        else if (row !== undefined) ctx.push(repoScreen(f, ctx, local(f, row.repo)));
        return true;
      }
      if (e.key === "u" && relation !== undefined && mayPropose()) {
        propose();
        return true;
      }
      if (e.key === "t" && offer !== undefined) {
        take();
        return true;
      }
      if (e.key === "m" && canSetMode()) {
        runAsync(ctx, async () => {
          // `m` steps through the three modes in turn.
          const next = FORK_FOLLOW_MODES[(FORK_FOLLOW_MODES.indexOf(mode ?? "tell-me") + 1) % FORK_FOLLOW_MODES.length]!;
          const set = await setFollowMode(f.app, f.user, repo, next);
          if (!set.ok) return ctx.toast(FOLLOW_MODE_REFUSALS[set.error].message, "danger");
          await read();
          ctx.toast(followModeSaid(relation?.parent, set.value), "success");
        });
        return true;
      }
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
  return self;
}

/** The line that says a proposal is already open, so `u` opens it instead of making another. */
function openRow(pull: Pull, parent: Repo): ForkRow {
  return {
    repo: parent,
    name: `#${pull.number} is open on ${parent.ownerName}/${parent.name}`,
    words: "enter or u opens it",
    heading: "",
  };
}
