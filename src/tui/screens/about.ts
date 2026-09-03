/**
 * `I` — everything a repository *is*, in one card.
 *
 * What it is for, whether it is private, which branch is the default, how to
 * clone it, and — on a mirror — where it came from and when it was last
 * fetched. This is what the repository's home page used to be, and the whole
 * argument for making it a card is that nobody ever went to that page on
 * purpose: they went *through* it, on the way to a file or an issue. So the
 * workspace opens on the work, and the facts are one keystroke away from
 * wherever you already are.
 *
 * The clone URLs are the point of it. They are the single most-copied string
 * on any forge, and the one thing a terminal can hand over without a mouse —
 * `y` puts one on the reader's own clipboard over OSC 52, and every URL on the
 * card is an OSC 8 hyperlink besides.
 */

import { isPinned } from "../../core/pins.ts";
import type { Repo } from "../../core/repos.ts";
import type { RepoFacts, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { badge, card } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { PIN_MARK, ago, drawFacts, plural } from "./common.ts";
import { forkOf, hostOf, liveOrigin, localRepo, sourceName } from "./where.ts";

/**
 * `I` — everything a repository is, in one card: what it is for, whether it
 * is private, how to clone it, and where it came from. This is what the repo
 * home page used to be, and it is a card rather than a screen because it is
 * something you glance at on the way to doing something else.
 */
export function aboutScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  src: RepoSource,
  facts: RepoFacts | undefined,
  ref: string,
): Screen {
  const repo = localRepo(src);
  const rows = aboutFacts(f, src, facts, ref);
  const cloneUrl = rows.find(([label]) => label.startsWith("clone"))?.[1] ?? "";
  return {
    title: "About",
    keys: [
      binding(["y"], "copy the clone URL", { disabled: cloneUrl === "" }),
      binding(["esc"], "close"),
    ],
    render(area, s) {
      parent.render(area, s);
      const c = ctx.theme.c;
      const w = Math.min(72, Math.max(30, area.w - 6));
      // The frame, the badges, the description, a blank, and one row per
      // fact — a card with empty rows under its last line reads as a card
      // that lost something.
      const h = Math.min(area.h, rows.length + 5);
      const r = {
        x: area.x + ((area.w - w) >> 1),
        y: area.y + ((area.h - h) >> 1),
        w,
        h,
      };
      const inner = card(s, r, c, {
        title: sourceName(src),
        footer: ref,
        focused: true,
      });
      const lead = inner.x + 1;
      const edge = inner.x + inner.w;
      const visibility = facts?.visibility ?? repo?.visibility ?? "public";
      let x = badge(s, inner.x, inner.y, c, {
        text: visibility,
        variant: visibility === "public" ? "success" : "secondary",
      });
      if (repo?.protectDefault === true)
        x = badge(s, x + 1, inner.y, c, { text: "protected", variant: "attn" });
      if (repo !== undefined && repo.forkParentId !== null)
        x = badge(s, x + 1, inner.y, c, { text: "fork", variant: "outline" });
      if (repo !== undefined && repo.origin !== null)
        x = badge(s, x + 1, inner.y, c, { text: "mirror", variant: "attn" });
      if (repo === undefined)
        x = badge(s, x + 1, inner.y, c, {
          text: "read-only",
          variant: "outline",
        });
      if (
        repo !== undefined &&
        f.user !== undefined &&
        isPinned(f.db, f.user.id, repo.id)
      )
        badge(s, x + 1, inner.y, c, {
          text: `${PIN_MARK} on your machine`,
          variant: "outline",
        });
      const description = facts?.description ?? repo?.description ?? "";
      s.text(
        lead,
        inner.y + 1,
        truncate(
          description === "" ? "No description." : description,
          Math.max(0, edge - lead),
        ),
        style(description === "" ? c.faint : c.fg, c.card),
        edge,
      );
      drawFacts(
        s,
        {
          x: lead,
          y: inner.y + 3,
          w: Math.max(0, edge - lead),
          h: Math.max(0, inner.h - 3),
        },
        c,
        rows,
        c.card,
      );
    },
    key(e) {
      if (e.key === "y" && cloneUrl !== "") {
        ctx.copy(cloneUrl);
        ctx.toast("copied the clone URL", "success");
        return true;
      }
      if (e.key === "esc" || e.key === "q" || e.key === "I") {
        ctx.pop();
        return true;
      }
      return true;
    },
  };
}

/**
 * The label/value block. A repository we hold gets the clone URLs (the single
 * most-copied string on any forge, and the one thing a terminal can hand over
 * without a mouse); a live browse gets the page it is reading instead.
 */
function aboutFacts(
  f: Session,
  src: RepoSource,
  facts: RepoFacts | undefined,
  ref: string,
): [string, string][] {
  const repo = localRepo(src);
  const counts: [string, string][] =
    facts === undefined ||
    ((facts.openIssues ?? 0) === 0 && (facts.openPulls ?? 0) === 0)
      ? []
      : [
          [
            "open",
            [
              facts.openIssues === null
                ? ""
                : plural(facts.openIssues, "issue"),
              facts.openPulls === null ? "" : plural(facts.openPulls, "pull"),
            ]
              .filter((p) => p !== "")
              .join(" · "),
          ],
        ];
  const branch = facts?.defaultBranch ?? repo?.defaultBranch ?? "";
  // Whose work this descends from. A fork at an origin is not `forkParentId`
  // — that is a fork made *here* — so the badge above cannot say it and this
  // row can.
  const upstream = forkOf(f, src);
  const fork: [string, string][] =
    upstream === "" ? [] : [["fork of", upstream]];
  // "browsing" only when it is not the obvious answer: a row that repeats
  // the line above it is a row nobody reads.
  const browsing: [string, string][] =
    ref === "" || ref === branch ? [] : [["browsing", ref]];
  if (repo !== undefined)
    return [
      ["default branch", branch],
      ...browsing,
      ...counts,
      ...fork,
      ...originFacts(repo),
      ...cloneFacts(f, repo),
    ];
  const live = liveOrigin(src);
  const out: [string, string][] = [];
  if (live !== undefined)
    out.push([
      "reading",
      `${hostOf(live.origin.webUrl)} · ${live.origin.login}'s connection`,
    ]);
  if (facts !== undefined) {
    out.push(["default branch", facts.defaultBranch]);
    if (facts.pushedAt !== null) out.push(["last push", ago(facts.pushedAt)]);
  }
  out.push(...browsing);
  out.push(...counts);
  out.push(...fork);
  if (live !== undefined) out.push(["page", live.htmlUrl]);
  return out;
}

/** Where a mirror came from and when it was last fetched — one line. */
function originFacts(repo: Repo): [string, string][] {
  const origin = repo.origin;
  if (origin === null) return [];
  const host = hostOf(origin.htmlUrl);
  const fetched =
    origin.lastFetchAt === null
      ? "never fetched"
      : `fetched ${ago(origin.lastFetchAt)}`;
  const error = origin.fetchError === "" ? "" : ` · ${origin.fetchError}`;
  return [
    [
      "mirrored from",
      `${origin.fullName}${host === "" ? "" : ` @ ${host}`} · ${fetched}${error}`,
    ],
  ];
}

/** The two clone URLs, from the ports this forge is actually listening on. */
export function cloneFacts(f: Session, repo: Repo): [string, string][] {
  const host = f.app.config.host ?? "localhost";
  const path = `${repo.ownerName}/${repo.name}.git`;
  const out: [string, string][] = [
    ["clone (http)", `http://${host}:${f.app.config.port ?? 3000}/${path}`],
  ];
  if (f.app.config.sshPort !== undefined)
    out.push([
      "clone (ssh)",
      `ssh://git@${host}:${f.app.config.sshPort}/${path}`,
    ]);
  return out;
}

