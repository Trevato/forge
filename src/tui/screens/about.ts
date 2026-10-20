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
import { checkMemoryAt } from "../../apps/check-memory.ts";
import { repoDir } from "../../git/repos.ts";
import { listRefs } from "../../git/read.ts";
import { updateRepoSettings } from "../../actions/repos.ts";
import { canAdmin, getRepoById, type Repo } from "../../core/repos.ts";
import type { RepoFacts, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { badge, card } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { PIN_MARK, ago, drawFacts, plural } from "./common.ts";
import { egressScreen } from "./egress.ts";
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
  // Archiving changes the row under this card, so read it at use.
  let repo = localRepo(src);
  const may = (): boolean =>
    repo !== undefined && f.user !== undefined && canAdmin(f.db, repo, f.user);
  let cell: [string, string][] = [];
  const factRows = (): [string, string][] => [
    ...archivedRow(repo),
    ...aboutFacts(f, src, facts, ref),
    ...cell,
  ];
  let rows = factRows();
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
        // A site admin also reaches the repository's private egress grants.
        ...(f.user?.isAdmin === true && repo !== undefined
          ? [binding(["e"], "egress")]
          : []),
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
      if (e.key === "e" && repo !== undefined && f.user?.isAdmin === true) {
        ctx.push(egressScreen(f, ctx, repo));
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

