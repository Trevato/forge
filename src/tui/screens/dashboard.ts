/**
 * The first thing a session shows, a short launcher: your repositories (and,
 * as you type, every repository you can see), what is on you, what is on
 * your machine, and — for a guest — the way in. Enter opens one in the
 * workspace or the review; what happened, and other people's pages, are the
 * web's feed and explorer (#636).
 *
 * A guest is not a degraded user. They get the same list, filtered to what is
 * public by exactly the helpers the web and the API use, plus one extra row
 * telling them how to become someone.
 *
 * Every card here is a **pane**: a thing with a cursor, that `tab` moves
 * between, that `enter` opens from, and that a click lands in. That is the
 * whole of this screen's design.
 */

import { holdWords, plannerHold } from "../../crew/autonomy.ts";
import { forgeNeeds } from "../../actions/health.ts";
import { mayView } from "../../core/sealed.ts";
import { pinRepo, unpinRepo } from "../../actions/origins.ts";
import { listAssignedTo, type Issue } from "../../core/issues.ts";
import {
  applyAsksBulk,
  latestUndoable,
  undoAsksBulk,
} from "../../actions/asks_bulk.ts";
import { mutedRepos, removeMutes } from "../../core/interactions.ts";
import type { Operation } from "../../core/fleet_ops.ts";
import { listPins, pinnedRepoIds, type Pin } from "../../core/pins.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import {
  canRead,
  getRepo,
  getReposByIds,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Rect, Screen as Surface } from "../term/screen.ts";
import { style } from "../term/style.ts";
import type { Tokens } from "../ui/theme.ts";
import { truncate } from "../term/width.ts";
import { beside, fill, len, split } from "../ui/layout.ts";
import { icon, type IconSet } from "../ui/icons.ts";
import { card, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ISSUE_MARK,
  ListState,
  PIN_MARK,
  PULL_MARK,
  confirmScreen,
  countsColumn,
  metaOf,
  drawList,
  errorText,
  hitList,
  live,
  runAsync,
  type ListRow,
  openOnWeb,
  promptScreen,
  plural,
} from "./common.ts";
import { issueScreen } from "./issue.ts";
import { newRepoScreen } from "./newrepo.ts";
import { pullScreen } from "./pull.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";
import { signInScreen } from "./signin.ts";

/**
 * The three things the launcher is about. Order is the `tab` order: the
 * repositories, then what is waiting on you, then what is on your machine.
 * What happened and what is running are the web's questions.
 */
type PaneId = "repos" | "onyou" | "machine";

const TITLES: Readonly<Record<PaneId, string>> = {
  repos: "Repositories",
  onyou: "On you",
  machine: "On your machine",
};

/** An issue or a pull assigned to the viewer, with the repository it is in. */
interface OnYouItem {
  readonly issue: Issue;
  readonly repo: Repo;
}

/** The `tab` order, whichever of these the frame had room for. */
const ORDER: readonly PaneId[] = ["repos", "onyou", "machine"];

export function dashboardScreen(f: Session, ctx: Ctx): Screen {
  let repos: Repo[] = [];
  let all: Repo[] = [];
  let pins: Pin[] = [];
  let pinned = new Set<string>();
  let onYou: OnYouItem[] = [];
  /** Repositories the viewer muted that hold work assigned to them: said, never silent. */
  let silenced = new Map<string, Repo>();
  /** The rows marked for one verb, by issue id. */
  const marked = new Set<string>();
  let lastSet: Operation | undefined;
  /** Why planning is paused, for the autonomous apps where it is; as on the board. */
  let holds = new Map<string, string>();
  let forge: string[] | undefined;
  const filter = new Filter();
  /** One cursor per pane: moving in one must never move another. */
  const cursors: Record<PaneId, ListState> = {
    repos: new ListState(),
    onyou: new ListState(),
    machine: new ListState(),
  };
  let focus: PaneId = "repos";

  const reload = (): void => {
    // The server remembers the *choice* and nothing about the laptop, so
    // this is a list of decisions — never a status that would be stale.
    pins = f.user ? listPins(f.db, f.user.id) : [];
    pinned = f.user ? pinnedRepoIds(f.db, f.user.id) : new Set<string>();
    all = listReposVisibleTo(f.db, f.user, { limit: 200 });
    onYou = assignedToMe();
    for (const id of [...marked])
      if (!onYou.some((item) => item.issue.id === id)) marked.delete(id);
    lastSet = f.user ? latestUndoable(f.app, f.user) : undefined;
    const now = new Date();
    holds = new Map(
      all.flatMap((repo) => {
        const hold =
          repo.autonomy === "autonomous" ? plannerHold(f.app, repo, now) : null;
        return hold === null ? [] : [[repo.id, holdWords(hold)] as const];
      }),
    );
    forge = forgeNeeds(f.app, f.user);
    // "Yours" is ownership plus the orgs you are on a team of; typing in the
    // filter reaches every repository you can see.
    const orgs = f.user
      ? listOrgsForUser(f.db, f.user.id).map((o) => o.username)
      : [];
    repos = f.user
      ? all.filter(
          (repo) =>
            repo.ownerId === f.user?.id || orgs.includes(repo.ownerName),
        )
      : all;
    ctx.invalidate();
  };

  /**
   * What is assigned to the viewer, open, newest first. The rows come from
   * one query and the repositories from one grouped read; `canRead` is the
   * same filter every list applies, so an assignment in a repository this
   * account has since lost cannot appear here.
   */
  const assignedToMe = (): OnYouItem[] => {
    if (f.user === undefined) return [];
    const issues = listAssignedTo(f.db, f.user.id, 50);
    const muted = mutedRepos(f.db, f.user.id);
    silenced = new Map();
    const byId = getReposByIds(
      f.db,
      issues.map((issue) => issue.repoId),
    );
    return issues.flatMap((issue) => {
      const repo = byId.get(issue.repoId);
      if (
        repo === undefined ||
        !canRead(f.db, repo, f.user) ||
        !mayView(f.db, repo, issue, f.user)
      )
        return [];
      if (muted.has(repo.id)) {
        silenced.set(repo.id, repo);
        return [];
      }
      return [{ issue, repo }];
    });
  };

  /** The marked rows, or the one under the cursor when none is marked. */
  const targets = (): OnYouItem[] => {
    const picked = onYou.filter((item) => marked.has(item.issue.id));
    const here = onYou[at("onyou").index];
    return picked.length > 0 ? picked : here === undefined ? [] : [here];
  };

  /** One verb for the set, through the same action the web and API use. */
  const clear = (action: "close" | "mute" | "ship", reason?: string): void => {
    const items = targets().map((t) => `issue:${t.issue.id}`);
    if (items.length === 0) return;
    runAsync(ctx, async () => {
      const done = await applyAsksBulk(f.app, f.user, action, items, reason);
      if (!done.ok) {
        ctx.toast(done.error.message, "danger");
        return;
      }
      const ok = done.value.rows.filter((r) => r.outcome === "ok").length;
      const refused = [
        ...done.value.rows
          .filter((r) => r.outcome !== "ok")
          .map((r) => `${r.label}: ${r.reason}`),
        ...done.value.skipped.map((s) => `${s.item}: ${s.reason}`),
      ];
      marked.clear();
      reload();
      ctx.toast(
        `${action}: ${ok} done` +
          (refused.length > 0 ? `, ${refused.length} refused (${refused[0]})` : "") +
          (ok > 0 ? " · u undoes" : ""),
        refused.length > 0 ? "attn" : "success",
      );
    });
  };

  const closeSet = (): void => {
    if (targets().length === 0) return;
    ctx.push(
      promptScreen(ctx, screen, {
        title: `Close ${plural(targets().length, "item")}`,
        label: "Reason",
        hint: "One reason, written on each. Empty is fine.",
        onSubmit: (value) => {
          clear("close", value.trim());
          return undefined;
        },
      }),
    );
  };

  const shipSet = (): void => {
    const n = targets().length;
    if (n === 0) return;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Ship",
        body: [`Ship ${plural(n, "item")}? Each is checked for your access.`],
        actions: [
          { label: "Cancel", variant: "ghost" },
          { label: "Ship", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index === 1) clear("ship");
        },
      }),
    );
  };

  const undoSet = (): void => {
    const op = lastSet;
    if (op === undefined) {
      ctx.toast("nothing to undo", "attn");
      return;
    }
    runAsync(ctx, async () => {
      const done = await undoAsksBulk(f.app, f.user, op.id);
      reload();
      ctx.toast(
        done.ok ? "undone" : done.error.message,
        done.ok ? "success" : "danger",
      );
    });
  };

  const listenAgain = (): void => {
    if (f.user === undefined || silenced.size === 0) return;
    removeMutes(
      f.db,
      f.user.id,
      [...silenced.keys()].map((id) => `repo:${id}`),
    );
    reload();
    ctx.toast("listening again", "success");
  };

  /** Yours with an empty filter; anything you can see once you type —
   * the one way to find someone else's repository from here. */
  const shown = (): Repo[] =>
    (filter.query !== "" ? all : repos).filter((repo) =>
      filter.matches(`${repo.ownerName}/${repo.name} ${repo.description}`),
    );

  /**
   * The panes the last frame drew, which is what `tab` can reach — a focus
   * ring on a card that is not on screen is worse than no focus ring. The
   * frame decides, not a rule repeated here: at two columns everything is
   * up; narrower, the activity feed stacks under the repositories and the
   * three small cards wait for a wider window; shorter still, the
   * repositories have the whole body.
   */
  let drawn: ReadonlySet<PaneId> = new Set<PaneId>(["repos"]);
  const panes = (): PaneId[] => ORDER.filter((pane) => drawn.has(pane));

  const at = (pane: PaneId): ListState => cursors[pane];
  const size = (pane: PaneId): number =>
    pane === "repos"
      ? shown().length
      : pane === "onyou"
        ? onYou.length
        : pins.length;

  const cycle = (step: number): void => {
    const list = panes();
    const here = Math.max(0, list.indexOf(focus));
    focus = list[(here + step + list.length) % list.length] ?? "repos";
  };

  /** `enter` on a repository row, wherever the row came from. */
  const openRepo = (repo: Repo | undefined): void => {
    if (repo !== undefined) ctx.push(repoScreen(f, ctx, local(f, repo)));
  };

  const openPin = (pin: Pin | undefined): void => {
    if (pin === undefined) return;
    const repo = getRepo(f.db, pin.ownerName, pin.name);
    // A pin is a decision this account made; the repository behind it can
    // still have gone away or stopped being visible, and that is a sentence
    // to say rather than a dead keypress.
    if (repo === undefined || !canRead(f.db, repo, f.user)) {
      ctx.toast(`${pin.ownerName}/${pin.name} is not here any more`, "attn");
      return;
    }
    openRepo(repo);
  };

  const unpin = (pin: Pin | undefined): void => {
    if (pin === undefined || f.user === undefined) return;
    const user = f.user;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Unpin",
        body: [
          `Stop keeping ${pin.ownerName}/${pin.name} on your machine?`,
          "Nothing here is deleted; forge sync simply stops fetching it.",
        ],
        actions: [
          { label: "Keep it", variant: "ghost" },
          { label: "Unpin", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index !== 1) return;
          const repo = getRepo(f.db, pin.ownerName, pin.name);
          if (repo !== undefined) unpinRepo(f.app, user, repo);
          reload();
          ctx.toast("unpinned", "success");
        },
      }),
    );
  };

  const openAssigned = (item: OnYouItem | undefined): void => {
    if (item === undefined) return;
    const src = local(f, item.repo);
    ctx.push(
      item.issue.kind === "pull"
        ? pullScreen(f, ctx, src, item.issue.number)
        : issueScreen(f, ctx, src, item.issue.number),
    );
  };

  /** `enter` on whatever the focused pane's cursor is on. */
  const openHere = (): void => {
    if (focus === "repos") openRepo(shown()[at("repos").index]);
    else if (focus === "onyou") openAssigned(onYou[at("onyou").index]);
    else openPin(pins[at("machine").index]);
  };

  const screen: Screen = {
    title: f.user ? f.user.username : "Guest",
    get keys() {
      return [
        binding(["tab"], "next pane", { disabled: panes().length < 2 }),
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["/"], "find"),
        binding(["p"], "pin", { disabled: !f.signedIn }),
        // The On you verbs show only where they act, so the bar stays short.
        ...(focus === "onyou" && onYou.length > 0
          ? [
              binding(["space"], "mark"),
              binding(["x"], "close"),
              binding(["m"], "mute"),
              binding(["S"], "ship"),
            ]
          : []),
        ...(lastSet !== undefined ? [binding(["u"], "undo")] : []),
        ...(silenced.size > 0 ? [binding(["L"], "listen again")] : []),
        binding(["d"], "unpin", {
          disabled: focus !== "machine" || pins.length === 0,
        }),
        binding(["n"], "new repo", { disabled: !f.signedIn }),
        binding(["A"], "account", { disabled: !f.signedIn }),
        binding(["s"], "sign in", { disabled: f.signedIn }),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      // The repo list, the counts beside it and what is on you are all
      // functions of the outbox, so one subscription refreshes all of them.
      live(f, signal, {}, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const set = ctx.icons;
      // A site admin's forge strip, as the board's: "All fine" or a line
      // per cause. Anyone else gets no rows and no reads.
      let body = area;
      if (forge !== undefined) {
        const lines = forge.length === 0 ? ["All fine"] : forge.slice(0, 3);
        const [strip, rest] = split(area, "v", [len(lines.length), fill(1)]);
        lines.forEach((line, i) =>
          s.text(
            strip!.x,
            strip!.y + i,
            truncate(line, strip!.w),
            style(forge!.length === 0 ? c.mutedFg : c.fg, c.bg),
            strip!.x + strip!.w,
          ),
        );
        body = rest!;
      }
      const { main, aside, stacked } = beside(body, ctx.twoPane, {
        main: fill(3),
        aside: fill(2),
      });
      // Decide what is on screen before drawing any of it: the focus ring is
      // painted by the draws, and a window that just shrank may have taken
      // the focused pane away, in which case the cursor lands on the
      // repositories, which are always there.
      const here = new Set<PaneId>(["repos"]);
      if (aside !== undefined && f.signedIn) here.add("onyou");
      if (aside !== undefined && !stacked && f.signedIn) here.add("machine");
      drawn = here;
      if (!here.has(focus)) focus = "repos";

      const [box, list] = split(main, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "find a repository"));
      drawRepos(s, list!, c, set);
      if (aside === undefined) return;
      if (!f.signedIn) {
        drawMachine(s, aside, c, set);
        return;
      }
      if (stacked) {
        drawOnYou(s, aside, c, set);
        return;
      }
      const [onYouArea, machine] = split(aside, "v", [fill(1), len(8)]);
      drawOnYou(s, onYouArea!, c, set);
      drawMachine(s, machine!, c, set);
    },
    key(e) {
      if (filter.key(e)) {
        at("repos").clamp(shown().length);
        focus = "repos";
        return true;
      }
      if (e.key === "tab") {
        cycle(e.shift ? -1 : 1);
        return true;
      }
      if (at(focus).key(e, size(focus))) return true;
      if (e.key === "enter") {
        openHere();
        return true;
      }
      if (focus === "onyou" && f.user !== undefined) {
        const item = onYou[at("onyou").index];
        if (e.key === "space" && item !== undefined) {
          if (!marked.delete(item.issue.id)) marked.add(item.issue.id);
          return true;
        }
        if (e.key === "x") return closeSet(), true;
        if (e.key === "m") return clear("mute"), true;
        if (e.key === "S") return shipSet(), true;
      }
      if (e.key === "u" && f.user) return undoSet(), true;
      if (e.key === "L" && f.user) return listenAgain(), true;
      if (e.key === "d" && focus === "machine") {
        unpin(pins[at("machine").index]);
        return true;
      }
      if (e.key === "p" && f.user) {
        const repo = shown()[at("repos").index];
        if (!repo) return true;
        const wanted = !pinned.has(repo.id);
        const done = wanted
          ? pinRepo(f.app, f.user, repo)
          : unpinRepo(f.app, f.user, repo);
        if (!done.ok && wanted) ctx.toast(errorText(done.error), "danger");
        else {
          reload();
          ctx.toast(wanted ? "pinned" : "unpinned", "success");
        }
        return true;
      }
      if (e.key === "n" && f.signedIn) {
        ctx.push(newRepoScreen(f, ctx));
        return true;
      }
      if (e.key === "A" && f.user) {
        openOnWeb(f, ctx, "/settings", "Account settings");
        return true;
      }
      if (e.key === "s" && !f.signedIn) {
        ctx.push(signInScreen(f, ctx, reload));
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => reload());
        return true;
      }
      return false;
    },
  };

  // ---- the panes ----

  /** The inbox: what is assigned to this account, across every repository. */
  function drawOnYou(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const on = focus === "onyou";
    const inner = card(s, r, c, {
      title: `${icon("person", set)} ${TITLES.onyou}`,
      focused: on,
      ...(onYouFooter() === undefined ? {} : { footer: onYouFooter()! }),
    });
    if (onYou.length === 0) {
      note(s, inner, c, [
        silenced.size > 0
          ? "Nothing is on you outside muted repositories."
          : "Nothing is assigned to you.",
      ]);
      return;
    }
    drawList(
      s,
      inner,
      c,
      at("onyou"),
      onYou.map((item): ListRow => {
        const mark =
          set === "nerd"
            ? icon(item.issue.kind === "pull" ? "pull" : "issue", set)
            : item.issue.kind === "pull"
              ? PULL_MARK
              : ISSUE_MARK;
        return {
          title: `${marked.has(item.issue.id) ? "[x] " : ""}${mark} #${item.issue.number} ${item.issue.title}`,
          meta: `${item.repo.ownerName}/${item.repo.name}`,
        };
      }),
      on,
    );
    hitList(ctx, inner, at("onyou"), onYou.length, {
      select: () => {
        focus = "onyou";
      },
      open: (index) => {
        focus = "onyou";
        openAssigned(onYou[index]);
      },
    });
  }

  /** What the card says about mutes, marks and the day's undo. */
  function onYouFooter(): string | undefined {
    const parts: string[] = [];
    if (marked.size > 0) parts.push(`${marked.size} marked`);
    if (silenced.size > 0)
      parts.push(
        `${silenced.size} ${silenced.size === 1 ? "repository" : "repositories"} muted · L listen again`,
      );
    if (lastSet !== undefined) parts.push(`u undo ${lastSet.verb}`);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }

  function drawRepos(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const rows = shown();
    const on = focus === "repos";
    if (rows.length === 0) {
      emptyState(s, r, c, {
        title: f.signedIn ? "No repositories yet" : "Nothing public yet",
        body: f.signedIn
          ? "Press n for a new repository, or / to find one."
          : "Press s to sign in, or / to find one.",
      });
      return;
    }
    // The counts come off `listReposVisibleTo`, which fills them in one
    // grouped query for the whole page — never one per row.
    const counts = countsColumn(
      rows.map((repo) => repo.counts),
      set,
    );
    drawList(
      s,
      r,
      c,
      at("repos"),
      rows.map(
        (repo): ListRow => ({
          title: `${repoMark(pinned.has(repo.id), set)}${repo.ownerName}/${repo.name}`,
          secondary: holds.get(repo.id) ?? repo.description,
          meta: metaOf(
            repo.visibility === "private" ? "private" : "",
            counts(repo.counts),
          ),
        }),
      ),
      on,
    );
    hitList(ctx, r, at("repos"), rows.length, {
      select: () => {
        focus = "repos";
      },
      open: (index) => {
        focus = "repos";
        openRepo(rows[index]);
      },
    });
  }

  function drawMachine(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const on = focus === "machine";
    if (!f.signedIn) {
      note(s, card(s, r, c, { title: "Sign in" }), c, [
        "s   sign in with a username and password",
        "    (your key is linked, so next time is instant)",
      ]);
      return;
    }
    const inner = card(s, r, c, {
      title: `${icon("pin", set)} ${TITLES.machine}`,
      // The command that acts on this list, on the card that shows it.
      footer: "forge sync",
      focused: on,
    });
    if (pins.length === 0) {
      note(s, inner, c, [
        "Nothing pinned yet.",
        "p pins the repository under the cursor;",
        'see "Origins" in the README for forge sync.',
      ]);
      return;
    }
    drawList(
      s,
      inner,
      c,
      at("machine"),
      pins.map(
        (pin): ListRow => ({
          title: `${repoMark(true, set)}${pin.ownerName}/${pin.name}`,
        }),
      ),
      on,
    );
    hitList(ctx, inner, at("machine"), pins.length, {
      select: () => {
        focus = "machine";
      },
      open: (index) => {
        focus = "machine";
        openPin(pins[index]);
      },
    });
  }

  return screen;
}

/**
 * The mark a repository row wears.
 *
 * `◆` has meant "kept on this machine" since the where-strip was written
 * (`docs/DESIGN.md`), and an unpinned row wears nothing — a column of marks
 * that are all the same says nothing. A Nerd Font session gets the real
 * nouns instead, because there the two glyphs are actually different
 * pictures rather than two shapes from the same small alphabet.
 */
function repoMark(isPinned: boolean, set: IconSet): string {
  if (set === "nerd") return `${icon(isPinned ? "pin" : "repo", set)} `;
  return isPinned ? `${PIN_MARK} ` : "";
}

/** Plain lines in a card — what a pane says when it has no rows. */
function note(s: Surface, r: Rect, c: Tokens, lines: readonly string[]): void {
  lines
    .slice(0, r.h)
    .forEach((line, i) =>
      s.text(
        r.x,
        r.y + i,
        truncate(line, r.w),
        style(c.mutedFg, c.card),
        r.x + r.w,
      ),
    );
}
