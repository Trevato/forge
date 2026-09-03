/**
 * The first thing a session shows: your repositories, what has happened in
 * them, and — for a guest — the way in.
 *
 * A guest is not a degraded user. They get the same list, filtered to what is
 * public by exactly the helpers the web and the API use, plus one extra row
 * telling them how to become someone.
 */

import { pinRepo, unpinRepo } from "../../actions/origins.ts";
import { getIssuesByRef } from "../../core/issues.ts";
import { listPins, pinnedRepoIds, type Pin } from "../../core/pins.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import { listEventsVisibleTo, type ForgeEvent } from "../../core/events.ts";
import {
  getReposByIds,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import { getUsersByIds } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Rect } from "../term/screen.ts";
import { style } from "../term/style.ts";
import type { Tokens } from "../ui/theme.ts";
import { pad, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  PIN_MARK,
  countsColumn,
  metaOf,
  drawList,
  errorText,
  live,
  relTime,
  runAsync,
  type ListRow,
} from "./common.ts";
import { describeEvent, type FeedLine } from "./activity.ts";
import { accountScreen } from "./account.ts";
import { exploreScreen } from "./explore.ts";
import { newRepoScreen } from "./newrepo.ts";
import { ownerScreen } from "./owner.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";
import { signInScreen } from "./signin.ts";

export function dashboardScreen(f: Session, ctx: Ctx): Screen {
  let repos: Repo[] = [];
  let feed: FeedItem[] = [];
  let orgs: string[] = [];
  let pins: Pin[] = [];
  let pinned = new Set<string>();
  const state = new ListState();
  const filter = new Filter();

  const reload = (): void => {
    // The server remembers the *choice* and nothing about the laptop, so
    // this is a list of decisions — never a status that would be stale.
    pins = f.user ? listPins(f.db, f.user.id) : [];
    pinned = f.user ? pinnedRepoIds(f.db, f.user.id) : new Set<string>();
    const all = listReposVisibleTo(f.db, f.user, { limit: 200 });
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

  const shown = (): Repo[] =>
    repos.filter((repo) =>
      filter.matches(`${repo.ownerName}/${repo.name} ${repo.description}`),
    );

  return {
    title: f.user ? f.user.username : "Guest",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["/"], "filter"),
        binding(["e"], "explore"),
        binding(["p"], "pin", { disabled: !f.signedIn }),
        binding(["n"], "new repo", { disabled: !f.signedIn }),
        binding(["A"], "account", { disabled: !f.signedIn }),
        binding(["s"], "sign in", { disabled: f.signedIn }),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      // Anything anyone does anywhere the viewer can see lands here: the
      // repo list, the counts beside it and the activity feed are all
      // functions of the outbox, so one subscription refreshes all three.
      live(f, signal, {}, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [left, right] = ctx.twoPane
        ? split(area, "h", [fill(3), fill(2)])
        : [area, undefined];
      const [box, list] = split(left, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "filter repositories"));
      const rows = shown();
      if (rows.length === 0)
        emptyState(s, list!, c, {
          title: f.signedIn ? "No repositories yet" : "Nothing public yet",
          body: f.signedIn
            ? "Press n to create one, or e to explore."
            : "Press s to sign in, or e to explore.",
        });
      else {
        // The counts come off `listReposVisibleTo`, which fills them in one
        // grouped query for the whole page — never one per row.
        const counts = countsColumn(rows.map((repo) => repo.counts));
        drawList(
          s,
          list!,
          c,
          state,
          rows.map(
            (repo): ListRow => ({
              title: `${pinned.has(repo.id) ? `${PIN_MARK} ` : ""}${repo.ownerName}/${repo.name}`,
              secondary: repo.description,
              meta: metaOf(
                repo.visibility === "private" ? "private" : "",
                counts(repo.counts),
              ),
            }),
          ),
        );
      }
      if (right === undefined) return;

      const [activity, side] = split(right, "v", [fill(2), len(7)]);
      const inner = card(s, activity!, c, { title: "Recent activity" });
      if (feed.length === 0)
        s.text(
          inner.x,
          inner.y,
          "Nothing has happened yet.",
          style(c.faint, c.card),
          inner.x + inner.w,
        );
      else drawFeed(s, inner, c, feed);
      // Pins earn the side card when there are any: what is on this machine
      // is a more useful thing to see at a glance than a list of orgs.
      const showPins = f.signedIn && pins.length > 0;
      const sideInner = card(s, side!, c, {
        title: showPins
          ? "On your machine"
          : f.signedIn
            ? "Organizations"
            : "Sign in",
      });
      const notes = showPins
        ? [
            ...pins
              .slice(0, 4)
              .map((pin) => `${PIN_MARK} ${pin.ownerName}/${pin.name}`),
            'forge sync   clone and refresh them (see "Origins" in the README)',
          ]
        : f.signedIn
          ? orgs.length > 0
            ? orgs
            : ["You are not in any organization."]
          : [
              "s   sign in with a username and password",
              "    (your key is linked, so next time is instant)",
            ];
      notes
        .slice(0, sideInner.h)
        .forEach((line, i) =>
          s.text(
            sideInner.x,
            sideInner.y + i,
            truncate(line, sideInner.w),
            style(c.mutedFg, c.card),
            sideInner.x + sideInner.w,
          ),
        );
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (state.key(e, shown().length)) return true;
      if (e.key === "enter") {
        const repo = shown()[state.index];
        if (repo) ctx.push(repoScreen(f, ctx, local(f, repo)));
        return true;
      }
      if (e.key === "e") {
        ctx.push(exploreScreen(f, ctx));
        return true;
      }
      if (e.key === "p" && f.user) {
        const repo = shown()[state.index];
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
}

interface FeedItem extends FeedLine {
  /** Relative, and short enough to right-align in its own column. */
  readonly when: string;
}

/** Time gets a fixed column so the stamps line up as a rule down the edge. */
const WHEN = 4;
/** Below this the second line has nothing left to say after truncation. */
const TWO_LINE = 40;

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
    const actor =
      event.actorId === null
        ? "someone"
        : (actors.get(event.actorId)?.username ?? "someone");
    const repo = event.repoId === null ? undefined : repos.get(event.repoId);
    const number = event.payload["number"];
    const title =
      repo !== undefined && typeof number === "number"
        ? titled.get(`${repo.id}#${number}`)?.title
        : undefined;
    const line = describeEvent(event, {
      actor,
      ...(repo === undefined ? {} : { repo: `${repo.ownerName}/${repo.name}` }),
      ...(title === undefined ? {} : { title }),
    });
    return line === null ? [] : [{ ...line, when: relTime(event.createdAt) }];
  });
}

/**
 * Two rows an item when there is room for the object of the sentence, one
 * truncated row when there is not. Either way the time is a right-hand
 * column, never a prefix that pushes the words around.
 */
function drawFeed(
  s: Parameters<typeof card>[0],
  r: Rect,
  c: Tokens,
  items: readonly FeedItem[],
): void {
  const right = r.x + r.w;
  const wide = r.w >= TWO_LINE;
  let y = r.y;
  for (const entry of items) {
    if (y >= r.y + r.h) return;
    if (!wide) {
      const tail = entry.subject === "" ? "" : ` · ${entry.subject}`;
      s.text(
        r.x,
        y,
        pad(entry.when, WHEN, "right"),
        style(c.faint, c.card),
        right,
      );
      s.text(
        r.x + WHEN + 1,
        y,
        truncate(`${entry.headline}${tail}`, Math.max(0, r.w - WHEN - 1)),
        style(c.mutedFg, c.card),
        right,
      );
      y += 1;
      continue;
    }
    s.text(
      r.x,
      y,
      truncate(entry.headline, Math.max(0, r.w - WHEN - 1)),
      style(c.fg, c.card),
      right,
    );
    s.text(
      right - WHEN,
      y,
      pad(entry.when, WHEN, "right"),
      style(c.faint, c.card),
      right,
    );
    y += 1;
    if (entry.detail !== "" && y < r.y + r.h) {
      s.text(
        r.x + 2,
        y,
        truncate(entry.detail, Math.max(0, r.w - 2)),
        style(c.faint, c.card),
        right,
      );
      y += 1;
    }
  }
}
