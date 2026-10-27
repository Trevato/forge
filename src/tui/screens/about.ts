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

import { audienceFor } from "../../core/audience.ts";
import { isPinned } from "../../core/pins.ts";
import { parentReleases, releasesSentence } from "../../core/parent_releases.ts";
import { running } from "../../kernel/version.ts";
import { sshCloneUrl } from "../../ssh/command.ts";
import { checkMemoryAt } from "../../apps/check-memory.ts";
import { repoDir } from "../../git/repos.ts";
import { forkDrift } from "../../actions/forks.ts";
import { upstreamOffer, type UpstreamOffer } from "../../actions/offer_upstream.ts";
import { listRefs } from "../../git/read.ts";
import { updateRepoSettings } from "../../actions/repos.ts";
import { showProvenance } from "../../actions/provenance.ts";
import {
  checkLine,
  checkedWords,
  checkUpstreamNow,
  FOLLOW_REFUSALS,
  behindWords,
  followShown,
  setFollowUpstream,
  standing,
  upstreamLabel,
} from "../../actions/upstream_follow.ts";
import { getFollow, listChecks } from "../../core/upstream_follow.ts";
import {
  getProvenance,
  shownTrail,
  sourceLabel,
} from "../../core/provenance.ts";
import {
  canAdmin,
  forkParentFor,
  getRepoById,
  type Repo,
} from "../../core/repos.ts";
import type { RepoFacts, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { badge, card } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { PIN_MARK, ago, drawFacts, plural } from "./common.ts";
import { connectionsScreen, egressScreen } from "./egress.ts";
import { newPullScreen } from "./newpull.ts";
import { pullScreen } from "./pull.ts";
import { forkOf, hostOf, liveOrigin, local, localRepo, sourceName } from "./where.ts";

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
  // Archiving changes the row under this card, so read it at use.
  let repo = localRepo(src);
  const may = (): boolean =>
    repo !== undefined && f.user !== undefined && canAdmin(f.db, repo, f.user);
  let cell: [string, string][] = [];
  let offered: UpstreamOffer | null = null;
  // The trail's switch (#3293) is a person's, an admin's, and only where
  // there is a trail to switch: the same rule as the settings page.
  const mayTrail = (): boolean =>
    may() &&
    f.user?.kind !== "agent" &&
    repo !== undefined &&
    getProvenance(f.db, repo.id) !== undefined;
  // FLOW ONLY is a person's, an admin's: the settings page's gate.
  const mayFlow = (): boolean => may() && f.user?.kind !== "agent";
  // The following card's rule: an admin's, and only while it is on or to be turned on.
  const mayFollow = (): boolean =>
    may() && repo !== undefined && repo.origin === null;
  const checking = (): boolean =>
    repo !== undefined && followShown(f.app, repo, f.user)?.enabled === true;
  const factRows = (): [string, string][] => [
    ...archivedRow(repo),
    ...flowRow(repo),
    ...aboutFacts(f, src, facts, ref),
    ...trailRows(f, repo),
    ...upstreamRows(f, repo),
    ...offerRows(offered),
    ...cell,
  ];
  let rows = factRows();
  // A fork ahead of its parent offers its commits upstream: the page's
  // button, read the same way (`upstreamOffer`), pressed here with `o`.
  const forkParent =
    repo === undefined ? undefined : forkParentFor(f.db, repo, f.user);
  if (repo !== undefined && forkParent !== undefined) {
    const at = repo;
    void forkDrift(f.app, at, forkParent)
      .then((drift) => {
        offered = upstreamOffer(f.app, f.user, at, forkParent, drift.ahead);
        if (offered === null) return;
        rows = factRows();
        ctx.invalidate();
      })
      .catch(() => {});
  }
  // An admin also sees the check cell's memory, read once from forge.json.
  if (may() && repo !== undefined) {
    const at = repo;
    void (async () => {
      const refs = await listRefs(repoDir(f.app.reposRoot, at.ownerName, at.name), "refs/heads/");
      const tip = refs.ok
        ? refs.value.find((r) => r.name === `refs/heads/${at.defaultBranch}`)?.oid
        : undefined;
      const words = await checkMemoryAt(repoDir(f.app.reposRoot, at.ownerName, at.name), tip);
      if (words === undefined) return;
      cell = wrap(words ?? "forge.json's check could not be read", 50).map(
        (line, i): [string, string] => [i === 0 ? "check cell" : "", line],
      );
      rows = factRows();
      ctx.invalidate();
    })().catch(() => {
      cell = [["check cell", "forge.json's check could not be read"]];
      rows = factRows();
      ctx.invalidate();
    });
  }
  const cloneUrl = rows.find(([label]) => label.startsWith("clone"))?.[1] ?? "";
  return {
    title: "About",
    get keys() {
      return [
        binding(["y"], "copy the clone URL", { disabled: cloneUrl === "" }),
        // Only an admin is offered the key, and only an admin's press counts.
        ...(may()
          ? [
              binding(
                ["a"],
                repo?.archivedAt === null ? "archive" : "wake",
              ),
            ]
          : []),
        ...(mayFlow()
          ? [binding(["w"], repo?.flowOnly === true ? "flow only off" : "flow only on")]
          : []),
        ...(mayTrail()
          ? [
              binding(
                ["t"],
                getProvenance(f.db, repo!.id)?.shown === true
                  ? "hide where this came from"
                  : "show where this came from",
              ),
            ]
          : []),
        ...(mayFollow()
          ? [
              ...(checking() ? [binding(["u"], "check upstream now")] : []),
              binding(["f"], checking() ? "stop following upstream" : "follow upstream"),
            ]
          : []),
        // A site admin also reaches the repository's private egress grants.
        ...(f.user?.isAdmin === true && repo !== undefined
          ? [binding(["e"], "egress"), binding(["c"], "connections")]
          : []),
        ...(offered === null
          ? []
          : [
              binding(
                ["o"],
                offered.openNumber === null
                  ? `offer ${plural(offered.ahead, "commit")} upstream`
                  : `see #${offered.openNumber} upstream`,
              ),
            ]),
        binding(["esc"], "close"),
      ];
    },
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
      // Who can see it, in the web page's words (#809).
      if (repo !== undefined)
        s.text(
          lead,
          inner.y + 2,
          truncate(
            audienceFor(f.db, repo, f.user).sentence,
            Math.max(0, edge - lead),
          ),
          style(c.mutedFg, c.card),
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
      if (e.key === "o" && repo !== undefined && offered !== null && forkParent !== undefined) {
        ctx.pop();
        ctx.push(
          offered.openNumber === null
            ? newPullScreen(f, ctx, repo)
            : pullScreen(f, ctx, local(f, forkParent), offered.openNumber),
        );
        return true;
      }
      if (e.key === "y" && cloneUrl !== "") {
        ctx.copy(cloneUrl);
        ctx.toast("copied the clone URL", "success");
        return true;
      }
      if (e.key === "a" && repo !== undefined && may()) {
        const waking = repo.archivedAt !== null;
        void updateRepoSettings(f.app, f.user, repo, {
          archived: !waking,
        }).then((done) => {
          if (done.ok) {
            repo = getRepoById(f.db, done.value.id) ?? done.value;
            rows = factRows();
            ctx.toast(waking ? "awake again" : "archived", "success");
          } else ctx.toast("that could not be changed", "danger");
          ctx.invalidate();
        });
        return true;
      }
      if (e.key === "w" && repo !== undefined && mayFlow()) {
        const on = !repo.flowOnly;
        void updateRepoSettings(f.app, f.user, repo, { flowOnly: on }).then((done) => {
          if (done.ok) {
            repo = getRepoById(f.db, done.value.id) ?? done.value;
            rows = factRows();
            ctx.toast(on ? "flow only is on" : "flow only is off", "success");
          } else ctx.toast("that could not be changed", "danger");
          ctx.invalidate();
        });
        return true;
      }
      if (e.key === "t" && repo !== undefined && mayTrail()) {
        const shown = getProvenance(f.db, repo.id)?.shown === true;
        const done = showProvenance(f.app, f.user, repo, !shown);
        if (done.ok) {
          rows = factRows();
          ctx.toast(done.value.shown ? "where this came from is shown" : "where this came from is hidden", "success");
        } else ctx.toast("that could not be changed", "danger");
        ctx.invalidate();
        return true;
      }
      if (e.key === "u" && repo !== undefined && mayFollow() && checking()) {
        const at = repo;
        ctx.toast("checking the upstream…", "default");
        void checkUpstreamNow(f.app, f.user, at)
          .then((done) => {
            rows = factRows();
            if (done.ok) ctx.toast(checkedWords(done.value), "success");
            else ctx.toast(FOLLOW_REFUSALS[done.error], "danger");
          })
          .catch(() => ctx.toast("that could not be checked", "danger"))
          .finally(() => ctx.invalidate());
        return true;
      }
      if (e.key === "f" && repo !== undefined && mayFollow()) {
        const on = !checking();
        const done = setFollowUpstream(f.app, f.user, repo, {
          url: "",
          branch: "",
          enabled: on,
        });
        if (done.ok)
          ctx.toast(on ? `following ${upstreamLabel(done.value.url)}` : "no longer following the upstream", "success");
        else
          ctx.toast(
            done.error === "invalid_url"
              ? "set the upstream address in the web settings first"
              : FOLLOW_REFUSALS[done.error],
            "danger",
          );
        rows = factRows();
        ctx.invalidate();
        return true;
      }
      if (e.key === "e" && repo !== undefined && f.user?.isAdmin === true) {
        ctx.push(egressScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "c" && f.user?.isAdmin === true) {
        ctx.push(connectionsScreen(f, ctx));
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
 * Where a migrated repository came from (#3293), as the web header says it:
 * the source, then each repository up the fork chain — a fork made here of
 * a migrated repository inherits its parent's. Nothing when `shownTrail`
 * has none.
 */
export function trailRows(
  f: Session,
  repo: Repo | undefined,
): [string, string][] {
  if (repo === undefined) return [];
  const trail = shownTrail(f.db, repo, forkParentFor(f.db, repo, f.user));
  if (trail === undefined) return [];
  return [
    ["migrated from", sourceLabel(trail.sourceUrl)],
    ...trail.parents.map((p): [string, string] => ["fork of", p]),
  ];
}

/** The offer row: what the fork has for its parent, and where it stands. */
export function offerRows(offer: UpstreamOffer | null): [string, string][] {
  if (offer === null) return [];
  return [
    [
      "offer",
      offer.openNumber === null
        ? `${plural(offer.ahead, "commit")} ahead · o opens the pull`
        : `${plural(offer.ahead, "commit")} ahead · offered in #${offer.openNumber}`,
    ],
  ];
}

/**
 * The upstream row, as the web About line has it: for an admin only, with
 * the address, branch and last check while following is on, and "off" when
 * it is not.
 */
export function upstreamRows(
  f: Session,
  repo: Repo | undefined,
): [string, string][] {
  if (repo === undefined || repo.origin !== null) return [];
  if (f.user === undefined || !canAdmin(f.db, repo, f.user)) return [];
  const follow = getFollow(f.db, repo.id);
  if (follow === undefined || !follow.enabled)
    return [["upstream", "off"]];
  const behind = behindWords(follow);
  const checked =
    follow.checkedAt === null ? "" : ` · checked ${ago(follow.checkedAt)}`;
  return [
    [
      "upstream",
      `${upstreamLabel(follow.url)} ${follow.branch}${checked} · ${standing(follow)}`,
    ],
    ...(behind === null ? [] : [["behind", `${behind.text} · u updates`] as [string, string]]),
    ...listChecks(f.db, repo.id).map((c): [string, string] => ["", checkLine(c, ago(c.at))]),
  ];
}

/** The FLOW ONLY switch, in the settings page's words; every reader sees it. */
export function flowRow(repo: Repo | undefined): [string, string][] {
  if (repo === undefined) return [];
  return [["Flow only", repo.flowOnly ? "on" : "off"]];
}

/** One line when an admin has put the repository away. */
function archivedRow(repo: Repo | undefined): [string, string][] {
  if (repo === undefined || repo.archivedAt === null) return [];
  return [["archived", repo.archivedAt.slice(0, 10)]];
}

/**
 * The web following card's releases sentence, for a fork on a forge that
 * names a parent forge: the same words, from the same cache.
 */
export function releasesRow(
  f: Session,
  repo: Repo | undefined,
): [string, string][] {
  const { parentUrl, dataDir, parentLoopback } = f.app.config;
  if (repo === undefined || repo.forkParentId === null) return [];
  if (parentUrl === undefined) return [];
  const view = parentReleases(dataDir, parentUrl, {
    loopback: parentLoopback === true,
  });
  return [
    [
      "releases",
      releasesSentence(view, running().version, new URL(parentUrl).host),
    ],
  ];
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
  const releases = releasesRow(f, repo);
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
      ...releases,
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

/**
 * The two clone URLs: HTTP from the forge's public address, the same one
 * the web page shows, and SSH from the one builder (absent when SSH is off).
 */
export function cloneFacts(f: Session, repo: Repo): [string, string][] {
  const config = f.app.config;
  const origin =
    config.url !== undefined
      ? new URL(config.url).origin
      : `http://${config.host ?? "localhost"}:${config.port ?? 3000}`;
  const out: [string, string][] = [
    ["clone (http)", `${origin}/${repo.ownerName}/${repo.name}.git`],
  ];
  const ssh = sshCloneUrl(f.app, repo.ownerName, repo.name);
  if (ssh !== undefined) out.push(["clone (ssh)", ssh]);
  return out;
}

