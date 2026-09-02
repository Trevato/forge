/**
 * Where you are reading from, said in one line on every repository screen.
 *
 * A repo screen renders a `RepoSource` and never asks which one it holds —
 * but a *person* must always know, because "read-only, over somebody else's
 * API" and "the copy we hold" are not the same repository and the difference
 * is invisible in a file list. So every repo screen carries the same strip
 * directly under its title: three places, three dots, plain words.
 *
 *     ● codeberg.org  ·  ○ workbench  ·  ○ this machine
 *     reading live from codeberg.org — read-only · m mirror into your workbench
 *
 * The dot is the whole grammar. Accent means *this is where the bytes on
 * this screen came from*; success means the place has this repository;
 * muted-hollow means it does not. `◆` is the pin glyph the dashboard already
 * uses for "kept on your machine" (`docs/DESIGN.md`), so the third place
 * wears it rather than inventing a fourth mark.
 *
 * A native repository has no origin, so it has no first place — two places
 * and no banner, rather than a place with nothing in it.
 */

import { isPinned } from "../../core/pins.ts";
import type { Repo } from "../../core/repos.ts";
import type { Origin } from "../../origins/types.ts";
import { localSource } from "../../view/local.ts";
import type { RepoSource } from "../../view/source.ts";
import {
  G,
  type Rect,
  type Screen as Surface,
  type Span,
} from "../term/screen.ts";
import { style, type Color } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Tokens } from "../ui/theme.ts";
import type { Session } from "../session.ts";
import { ago } from "./common.ts";

/**
 * A source over a repository we hold. Every caller of this already resolved
 * the repo through a read check (`canRead` in the dashboard, the palette, the
 * owner page) — `localSource` decides shape, not policy.
 */
export const local = (f: Session, repo: Repo): RepoSource =>
  localSource(f.app, repo, f.user);

/** The repository row behind a local source; undefined for a live browse. */
export const localRepo = (src: RepoSource): Repo | undefined =>
  src.where.kind === "local" ? src.where.repo : undefined;

/** The origin behind a live browse, with the name it is browsing. */
export function liveOrigin(
  src: RepoSource,
):
  | { origin: Origin; fullName: string; htmlUrl: string; mirroredAs?: Repo }
  | undefined {
  if (src.where.kind !== "origin") return undefined;
  const { origin, fullName, htmlUrl, mirroredAs } = src.where;
  return {
    origin,
    fullName,
    htmlUrl,
    ...(mirroredAs === undefined ? {} : { mirroredAs }),
  };
}

/** `owner/name`, whichever side it came from — every repo screen's title. */
export function sourceName(src: RepoSource): string {
  return src.where.kind === "local"
    ? `${src.where.repo.ownerName}/${src.where.repo.name}`
    : src.where.fullName;
}

/** The page for this repository on its origin, when there is one. */
export function originUrl(src: RepoSource): string {
  if (src.where.kind === "origin") return src.where.htmlUrl;
  const link = src.where.repo.origin;
  if (link === null) return "";
  return link.htmlUrl;
}

/** `codeberg.org` from `https://codeberg.org/octo/widgets`. */
export function hostOf(url: string): string {
  const parsed = URL.parse(url);
  return parsed === null ? url : parsed.host;
}

/** The branch a screen can open with before `describe()` has answered. */
export const knownDefaultRef = (src: RepoSource): string | undefined =>
  src.where.kind === "local" ? src.where.repo.defaultBranch : undefined;

/** Rows the strip needs: the places, plus the banner on a live browse. */
export const whereRows = (src: RepoSource): number =>
  src.where.kind === "origin" ? 2 : 1;

type Mark = "reading" | "present" | "pinned" | "absent";

interface Place {
  readonly mark: Mark;
  readonly text: string;
}

/** The three places, in the order the bytes travel: origin → here → laptop. */
export function places(f: Session, src: RepoSource): Place[] {
  const out: Place[] = [];
  if (src.where.kind === "origin") {
    const { origin, mirroredAs } = src.where;
    out.push({ mark: "reading", text: hostOf(origin.webUrl) });
    out.push(
      mirroredAs === undefined
        ? { mark: "absent", text: "workbench" }
        : {
            mark: "present",
            text: `workbench (${mirroredAs.ownerName}/${mirroredAs.name})`,
          },
    );
    out.push(machine(f, mirroredAs));
    return out;
  }
  const repo = src.where.repo;
  const link = repo.origin;
  if (link !== null)
    out.push({
      mark: "present",
      text: hostOf(link.htmlUrl === "" ? link.fullName : link.htmlUrl),
    });
  out.push({
    mark: "reading",
    text:
      link === null
        ? "workbench"
        : `workbench (${link.lastFetchAt === null ? "never synced" : `synced ${ago(link.lastFetchAt)}`})`,
  });
  out.push(machine(f, repo));
  return out;
}

function machine(f: Session, repo: Repo | undefined): Place {
  const pinned =
    repo !== undefined &&
    f.user !== undefined &&
    isPinned(f.db, f.user.id, repo.id);
  return { mark: pinned ? "pinned" : "absent", text: "this machine" };
}

const glyphOf = (mark: Mark): string =>
  mark === "absent" ? G.ring : mark === "pinned" ? G.diamond : G.dot;

const colorOf = (c: Tokens, mark: Mark): Color =>
  mark === "reading" ? c.accent : mark === "absent" ? c.faint : c.success;

/** The strip as spans, so a caller can measure it before it paints. */
export function whereSpans(f: Session, src: RepoSource, c: Tokens): Span[] {
  const spans: Span[] = [];
  places(f, src).forEach((place, i) => {
    if (i > 0) spans.push({ text: "  ·  ", style: style(c.faint, c.bg) });
    spans.push({
      text: glyphOf(place.mark),
      style: style(colorOf(c, place.mark), c.bg),
    });
    spans.push({
      text: ` ${place.text}`,
      style: style(place.mark === "reading" ? c.fg : c.mutedFg, c.bg),
    });
  });
  return spans;
}

/**
 * The one line a live browse adds. It says the two things a reader needs in
 * the order they need them: this is not ours, and here is the one key that
 * makes it ours.
 */
export function liveBanner(src: RepoSource): string {
  if (src.where.kind !== "origin") return "";
  const host = hostOf(src.where.origin.webUrl);
  return src.where.mirroredAs === undefined
    ? `reading live from ${host} — read-only · m mirror into your workbench`
    : `reading live from ${host} — read-only · the workbench copy is ${src.where.mirroredAs.ownerName}/${src.where.mirroredAs.name}`;
}

/**
 * Paint the strip (and the banner) into the rows `whereRows` asked for. The
 * caller splits its own area; this never guesses at a layout it was not given.
 */
export function whereStrip(
  s: Surface,
  r: Rect,
  c: Tokens,
  f: Session,
  src: RepoSource,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  s.spans(r.x, r.y, whereSpans(f, src, c), r.x + r.w);
  const banner = liveBanner(src);
  if (banner === "" || r.h < 2) return;
  s.text(
    r.x,
    r.y + 1,
    truncate(banner, r.w),
    style(c.mutedFg, c.bg),
    r.x + r.w,
  );
}
