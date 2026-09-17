/**
 * The first thing a session shows: your repositories, what has happened in
 * them, what is on your machine, and — for a guest — the way in.
 *
 * A guest is not a degraded user. They get the same list, filtered to what is
 * public by exactly the helpers the web and the API use, plus one extra row
 * telling them how to become someone.
 *
 * Every card here is a **pane**: a thing with a cursor, that `tab` moves
 * between, that `enter` opens from, and that a click lands in. That is the
 * whole of this screen's design. It used to be one navigable list plus three
 * read-only notes, and the notes were the parts people tried to click —
 * "recent activity" is a list of places you want to go, and printing it as
 * text was the bug.
 */

import { pinRepo, unpinRepo } from "../../actions/origins.ts";
import {
  getIssuesByRef,
  listAssignedTo,
  type Issue,
} from "../../core/issues.ts";
import { listPins, pinnedRepoIds, type Pin } from "../../core/pins.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import { listEventsVisibleTo, type ForgeEvent } from "../../core/events.ts";
import { eventActor } from "../../design/activity.ts";
import {
  canRead,
  getRepo,
  getReposByIds,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import { getUsersByIds } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Rect, Screen as Surface } from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import type { Tokens } from "../ui/theme.ts";
import { pad, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
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
  openLink,
  relTime,
  runAsync,
  type ListRow,
} from "./common.ts";
import { openEnvUrl } from "../../actions/apps.ts";
import { openAppTerminal } from "./apptty.ts";
import { describeEvent, type FeedLine } from "./activity.ts";
import { accountScreen } from "./account.ts";
import { appScreen } from "./app.ts";
import {
  appRow,
  appsScreen,
  listVisibleApps,
  newAppFlow,
  type AppItem,
} from "./apps.ts";
import { exploreScreen } from "./explore.ts";
import { issueScreen } from "./issue.ts";
import { newRepoScreen } from "./newrepo.ts";
import { ownerScreen } from "./owner.ts";
import { pullScreen } from "./pull.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";
import { signInScreen } from "./signin.ts";

/**
 * The six things a dashboard is about. Order is the `tab` order: apps first
 * because "what is running" is the question a person drops in to answer,
 * then the repositories, then what happened, then what is waiting on you.
 */
type PaneId = "apps" | "repos" | "activity" | "onyou" | "machine" | "orgs";

const TITLES: Readonly<Record<PaneId, string>> = {
  apps: "Apps",
  repos: "Repositories",
  activity: "Recent activity",
  onyou: "On you",
  machine: "On your machine",
  orgs: "Organizations",
};

/** An issue or a pull assigned to the viewer, with the repository it is in. */
interface OnYouItem {
  readonly issue: Issue;
  readonly repo: Repo;
}

/** The apps card shows this many before it scrolls. */
const APPS_ROWS = 5;

export function dashboardScreen(f: Session, ctx: Ctx): Screen {
  let repos: Repo[] = [];
  let feed: FeedItem[] = [];
  let orgs: string[] = [];
  let pins: Pin[] = [];
  let pinned = new Set<string>();
  let apps: AppItem[] = [];
  let onYou: OnYouItem[] = [];
  const filter = new Filter();
  /** One cursor per pane: moving in one must never move another. */
  const cursors: Record<PaneId, ListState> = {
    apps: new ListState(),
    repos: new ListState(),
    activity: new ListState(),
    onyou: new ListState(),
    machine: new ListState(),
    orgs: new ListState(),
  };
  let focus: PaneId = "repos";

  const reload = (): void => {
    // The server remembers the *choice* and nothing about the laptop, so
    // this is a list of decisions — never a status that would be stale.
    pins = f.user ? listPins(f.db, f.user.id) : [];
    pinned = f.user ? pinnedRepoIds(f.db, f.user.id) : new Set<string>();
    const all = listReposVisibleTo(f.db, f.user, { limit: 200 });
    // The apps are among the rows just listed: one grouped read, no second
    // listing. Every visible app is shown, not only "yours" — what is
    // running is the question, whoever owns it.
    apps = listVisibleApps(f, all);
    onYou = assignedToMe();
    // "Yours" is ownership plus the orgs you are on a team of; everything
    // else lives in Explore, one key away.
    orgs = f.user
      ? listOrgsForUser(f.db, f.user.id).map((o) => o.username)
      : [];
    repos = f.user
      ? all.filter(
          (repo) =>
            repo.ownerId === f.user?.id || orgs.includes(repo.ownerName),
        )
      : all;
    // The feed asks for *visible* events rather than the newest sixty and a
    // filter in JS: on a forge with any traffic at all, sixty events can be
    // sixty events in repos this session cannot see, and the old shape drew
    // an empty card. The predicate belongs in the query.
    const visible = listEventsVisibleTo(f.db, f.user, { limit: 40 });
    feed = feedItems(f, visible);
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
    const byId = getReposByIds(
      f.db,
      issues.map((issue) => issue.repoId),
    );
    return issues.flatMap((issue) => {
      const repo = byId.get(issue.repoId);
      return repo !== undefined && canRead(f.db, repo, f.user)
        ? [{ issue, repo }]
        : [];
    });
  };

  const shown = (): Repo[] =>
    repos.filter((repo) =>
      filter.matches(`${repo.ownerName}/${repo.name} ${repo.description}`),
    );

  /**
   * The panes that exist right now. Below two columns only the repo list is
   * drawn, so it is the only thing `tab` can reach — a focus ring on a card
   * that is not on screen is worse than no focus ring. The apps card is only
   * there when there is an app: an empty card saying so would take the rows
   * the repositories need, and `a` is the way to the apps screen regardless.
   */
  const panes = (): PaneId[] => {
    if (!ctx.twoPane) return ["repos"];
    const withApps: PaneId[] = apps.length > 0 ? ["apps"] : [];
    return f.signedIn
      ? [...withApps, "repos", "activity", "onyou", "machine", "orgs"]
      : [...withApps, "repos", "activity"];
  };

  const at = (pane: PaneId): ListState => cursors[pane];
  const size = (pane: PaneId): number =>
    pane === "apps"
      ? apps.length
      : pane === "repos"
        ? shown().length
        : pane === "activity"
          ? feed.length
          : pane === "onyou"
            ? onYou.length
            : pane === "machine"
              ? pins.length
              : orgs.length;

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

  /** `enter` in the feed: the issue, the pull, or the repository it names. */
  const openEvent = (item: FeedItem | undefined): void => {
    if (item === undefined) return;
    if (item.repo === undefined) {
      ctx.toast("that happened outside a repository", "attn");
      return;
    }
    const src = local(f, item.repo);
    if (item.number !== undefined && item.kind !== undefined) {
      ctx.push(
        item.kind === "pull"
          ? pullScreen(f, ctx, src, item.number)
          : issueScreen(f, ctx, src, item.number),
      );
      return;
    }
    ctx.push(repoScreen(f, ctx, src));
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

  const openApp = (item: AppItem | undefined): void => {
    if (item !== undefined) ctx.push(appScreen(f, ctx, item.repo));
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
    if (focus === "apps") openApp(apps[at("apps").index]);
    else if (focus === "repos") openRepo(shown()[at("repos").index]);
    else if (focus === "activity") openEvent(feed[at("activity").index]);
    else if (focus === "onyou") openAssigned(onYou[at("onyou").index]);
    else if (focus === "machine") openPin(pins[at("machine").index]);
    else {
      const org = orgs[at("orgs").index];
      if (org !== undefined) ctx.push(ownerScreen(f, ctx, org));
    }
  };

  const screen: Screen = {
    title: f.user ? f.user.username : "Guest",
    get keys() {
      return [
        binding(["tab"], "next pane", { disabled: panes().length < 2 }),
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["/"], "filter"),
        binding(["a"], "apps"),
        binding(["o"], "open in browser", { disabled: focus !== "apps" }),
        binding(["t"], "terminal", { disabled: focus !== "apps" }),
        binding(["e"], "explore"),
        binding(["p"], "pin", { disabled: !f.signedIn }),
        binding(["d"], "unpin", {
          disabled: focus !== "machine" || pins.length === 0,
        }),
        binding(["n"], "new repo", { disabled: !f.signedIn }),
        binding(["N"], "new app", { disabled: !f.signedIn }),
        binding(["A"], "account", { disabled: !f.signedIn }),
        binding(["s"], "sign in", { disabled: f.signedIn }),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      // Anything anyone does anywhere the viewer can see lands here: the
      // repo list, the counts beside it, the activity feed, the apps and
      // what is on you are all functions of the outbox, so one subscription
      // refreshes all of them. (Run events carry a repo id, so they pass the
      // same filter as everything else.)
      live(f, signal, {}, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const set = ctx.icons;
      if (!panes().includes(focus)) focus = "repos";
      const [left, right] = ctx.twoPane
        ? split(area, "h", [fill(3), fill(2)])
        : [area, undefined];
      const appsH =
        right === undefined || apps.length === 0
          ? 0
          : Math.min(apps.length, APPS_ROWS) + 2;
      const [appsArea, box, list] = split(left!, "v", [
        len(appsH),
        len(1),
        fill(1),
      ]);
      if (appsH > 0) drawApps(s, appsArea!, c, set);
      ctx.setCursor(filter.render(s, box!, c, "filter repositories"));
      drawRepos(s, list!, c, set);
      if (right === undefined) return;

      const [activity, onYouArea, machine, orgsArea] = split(right, "v", [
        fill(1),
        len(f.signedIn ? 6 : 0),
        len(6),
        len(5),
      ]);
      drawActivity(s, activity!, c, set);
      if (f.signedIn) drawOnYou(s, onYouArea!, c, set);
      drawMachine(s, machine!, c, set);
      drawOrgs(s, orgsArea!, c, set);
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
      if (e.key === "e") {
        ctx.push(exploreScreen(f, ctx));
        return true;
      }
      if (e.key === "a") {
        ctx.push(appsScreen(f, ctx));
        return true;
      }
      // Production, one key from the dashboard: through `openEnvUrl`, so a
      // private app's grant rides along.
      if (e.key === "o" && focus === "apps") {
        const item = apps[at("apps").index];
        if (!item) return true;
        const url = openEnvUrl(f.app, f.user, item.repo, "production");
        if (url.ok) openLink(ctx, url.value);
        else ctx.toast(errorText(url.error), "danger");
        return true;
      }
      // The app's own terminal, on this very pty: the UI steps aside.
      if (e.key === "t" && focus === "apps") {
        const item = apps[at("apps").index];
        if (item) void openAppTerminal(f, ctx, item.repo, "production");
        return true;
      }
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
      if (e.key === "N" && f.signedIn) {
        newAppFlow(f, ctx, screen);
        return true;
      }
      if (e.key === "A" && f.user) {
        ctx.push(accountScreen(f, ctx));
        return true;
      }
      if (e.key === "o" && f.user) {
        ctx.push(ownerScreen(f, ctx, f.user.username));
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

  /** What is running: every app, its production state, and its URL. */
  function drawApps(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const on = focus === "apps";
    const inner = card(s, r, c, {
      title: `${icon("terminal", set)} ${TITLES.apps}`,
      focused: on,
    });
    drawList(
      s,
      inner,
      c,
      at("apps"),
      apps.map((item) => appRow(item, set)),
      on,
    );
    hitList(ctx, inner, at("apps"), apps.length, {
      select: () => {
        focus = "apps";
      },
      open: (index) => {
        focus = "apps";
        openApp(apps[index]);
      },
    });
  }

  /** The inbox: what is assigned to this account, across every repository. */
  function drawOnYou(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const on = focus === "onyou";
    const inner = card(s, r, c, {
      title: `${icon("person", set)} ${TITLES.onyou}`,
      focused: on,
    });
    if (onYou.length === 0) {
      note(s, inner, c, ["Nothing is assigned to you."]);
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
          title: `${mark} #${item.issue.number} ${item.issue.title}`,
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

  function drawRepos(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const rows = shown();
    const on = focus === "repos";
    if (rows.length === 0) {
      emptyState(s, r, c, {
        title: f.signedIn ? "No repositories yet" : "Nothing public yet",
        body: f.signedIn
          ? "Press N for a new app, n for a plain repository, or e to explore."
          : "Press s to sign in, or e to explore.",
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
          secondary: repo.description,
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

  function drawActivity(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const on = focus === "activity";
    const inner = card(s, r, c, {
      title: `${icon("clock", set)} ${TITLES.activity}`,
      focused: on,
    });
    if (feed.length === 0) {
      s.text(
        inner.x,
        inner.y,
        "Nothing has happened yet.",
        style(c.faint, c.card),
        inner.x + inner.w,
      );
      return;
    }
    drawFeed(s, inner, c, feed, at("activity"), on);
    hitList(ctx, inner, at("activity"), feed.length, {
      select: () => {
        focus = "activity";
      },
      open: (index) => {
        focus = "activity";
        openEvent(feed[index]);
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

  function drawOrgs(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    if (!f.signedIn) {
      note(s, card(s, r, c, { title: "Explore" }), c, [
        "e   every repository this forge shows the public",
      ]);
      return;
    }
    const on = focus === "orgs";
    const inner = card(s, r, c, {
      title: `${icon("org", set)} ${TITLES.orgs}`,
      focused: on,
    });
    if (orgs.length === 0) {
      note(s, inner, c, ["You are not in any organization."]);
      return;
    }
    drawList(
      s,
      inner,
      c,
      at("orgs"),
      orgs.map(
        (org): ListRow => ({
          title: `${set === "nerd" ? `${icon("org", set)} ` : ""}${org}`,
        }),
      ),
      on,
    );
    hitList(ctx, inner, at("orgs"), orgs.length, {
      select: () => {
        focus = "orgs";
      },
      open: (index) => {
        focus = "orgs";
        const org = orgs[index];
        if (org !== undefined) ctx.push(ownerScreen(f, ctx, org));
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

interface FeedItem extends FeedLine {
  /** Relative, and short enough to right-align in its own column. */
  readonly when: string;
  /** Where `enter` goes: the repo, and the conversation if there is one. */
  readonly repo?: Repo;
  readonly number?: number;
  readonly kind?: "issue" | "pull";
}

/** Time gets a fixed column so the stamps line up as a rule down the edge. */
const WHEN = 4;

/**
 * Resolve everything `describeEvent` needs — the actor, the repo, and the
 * title of whatever the event numbered — and hand it the finished nouns.
 */
function feedItems(f: Session, events: readonly ForgeEvent[]): FeedItem[] {
  // Three grouped reads for the whole feed, not three per row: the actors,
  // the repos, and the titles of whatever was numbered. A feed is precisely
  // the list where N+1 is invisible in development and fatal in production.
  const actors = getUsersByIds(
    f.db,
    events.flatMap((e) => (e.actorId === null ? [] : [e.actorId])),
  );
  const repos = getReposByIds(
    f.db,
    events.flatMap((e) => (e.repoId === null ? [] : [e.repoId])),
  );
  const titled = getIssuesByRef(
    f.db,
    events.flatMap((e) =>
      e.repoId !== null && typeof e.payload["number"] === "number"
        ? [{ repoId: e.repoId, number: e.payload["number"] }]
        : [],
    ),
  );
  return events.flatMap((event) => {
    const actor = eventActor(
      event,
      event.actorId === null ? undefined : actors.get(event.actorId)?.username,
    );
    const repo = event.repoId === null ? undefined : repos.get(event.repoId);
    const number = event.payload["number"];
    const found =
      repo !== undefined && typeof number === "number"
        ? titled.get(`${repo.id}#${number}`)
        : undefined;
    const line = describeEvent(event, {
      actor,
      ...(repo === undefined ? {} : { repo: `${repo.ownerName}/${repo.name}` }),
      ...(found?.title === undefined ? {} : { title: found.title }),
    });
    if (line === null) return [];
    return [
      {
        ...line,
        when: relTime(event.createdAt),
        ...(repo === undefined ? {} : { repo }),
        // A number is only a destination when we found the row behind it —
        // otherwise `enter` would open a conversation that is not there.
        ...(found === undefined || typeof number !== "number"
          ? {}
          : { number, kind: found.kind }),
      },
    ];
  });
}

/**
 * One row per event, because a row is a thing you can put a cursor on and a
 * two-line item is not. The time is a right-hand column, never a prefix that
 * pushes the words around, and the object of the sentence trails the headline
 * when there is room for it.
 */
function drawFeed(
  s: Surface,
  r: Rect,
  c: Tokens,
  items: readonly FeedItem[],
  state: ListState,
  focused: boolean,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const right = r.x + r.w;
  const from = state.window(r.h, items.length);
  for (let i = 0; i < r.h; i++) {
    const entry = items[from + i];
    if (entry === undefined) break;
    const y = r.y + i;
    const selected = from + i === state.index;
    const bg = selected && focused ? c.muted : c.card;
    s.fill({ x: r.x, y, w: r.w, h: 1 }, " ", style(c.fg, bg));
    // The headline already ends with `#4`, so the subject repeats it. Drop
    // the duplicate: at this width every column spent twice is a title
    // truncated once.
    const ref = entry.number === undefined ? "" : `#${entry.number} `;
    const object =
      ref !== "" && entry.subject.startsWith(ref)
        ? entry.subject.slice(ref.length)
        : entry.subject;
    const tail = object === "" ? "" : ` · ${object}`;
    s.text(
      r.x,
      y,
      truncate(`${entry.headline}${tail}`, Math.max(0, r.w - WHEN - 1)),
      style(selected ? c.fg : c.mutedFg, bg, selected ? BOLD : 0),
      right,
    );
    s.text(
      right - WHEN,
      y,
      pad(entry.when, WHEN, "right"),
      style(c.faint, bg),
      right,
    );
  }
}
