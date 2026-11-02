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
import { getOriginRepo, repoForkOf } from "../../core/origins.ts";
import type { Repo } from "../../core/repos.ts";
import type { Origin } from "../../origins/types.ts";
import { localSource } from "../../view/local.ts";
import { sourceFor, type RepoSource } from "../../view/source.ts";
import {
  G,
  type Rect,
  type Screen as Surface,
  type Span,
} from "../term/screen.ts";
import { style, type Color } from "../term/style.ts";
import { displayWidth, truncate } from "../term/width.ts";
import type { Tokens } from "../ui/theme.ts";
import { icon, type IconName, type IconSet } from "../ui/icons.ts";
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

/** Which forge software is behind this source's origin, when there is one. */
export function originKind(
  src: RepoSource,
): "github" | "forgejo" | "gitea" | undefined {
  if (src.where.kind === "origin") return src.where.origin.kind;
  return src.where.repo.origin?.kind;
}

/**
 * The page for one *file* on the origin.
 *
 * Two shapes cover every forge we speak to: GitHub's `/blob/<ref>/<path>` and
 * Forgejo/Gitea's `/src/branch/<ref>/<path>`. This is a link we hand a person,
 * not an API call — a wrong guess costs a 404 in their browser, not a broken
 * read — so the branch is worth the two lines and the honesty of returning ""
 * when there is no origin at all.
 */
export function originFileUrl(
  src: RepoSource,
  ref: string,
  path: string,
): string {
  const base = originUrl(src);
  if (base === "" || path === "") return base;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const at = encodeURIComponent(ref);
  return originKind(src) === "github"
    ? `${base}/blob/${at}/${encoded}`
    : `${base}/src/branch/${at}/${encoded}`;
}

/**
 * `codeberg.org` from `https://codeberg.org/octo/widgets`; "" when it is not
 * a URL, so text a remote sent never reaches the terminal as itself.
 */
export function hostOf(url: string): string {
  return URL.parse(url)?.host ?? "";
}

/**
 * What names a mirror's origin: its host, or the `owner/name` it was given
 * when the page address is empty or not a URL. That name came from the remote,
 * so C0 and C1 control characters are dropped — it must print inert.
 */
export function hostLabel(htmlUrl: string, fullName: string): string {
  // eslint-disable-next-line no-control-regex
  return (hostOf(htmlUrl) || fullName).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/**
 * The same repository, read from the other side.
 *
 * A mirror has two truths a person moves between constantly: the copy here
 * and the live origin. `W` is that move, and this is the whole of it — a
 * local source whose repo has an origin becomes a live browse of it, and a
 * live browse that already has a mirror becomes the local source. Undefined
 * means there is no other side (a native repo, or an unmirrored browse), and
 * the access rules are `sourceFor`'s own: a live browse spends the origin
 * owner's credential, so anybody else gets nothing rather than somebody
 * else's connection.
 */
export function otherSide(f: Session, src: RepoSource): RepoSource | undefined {
  if (src.where.kind === "origin") {
    const mirror = src.where.mirroredAs;
    return mirror === undefined ? undefined : local(f, mirror);
  }
  const link = src.where.repo.origin;
  if (link === null) return undefined;
  const opened = sourceFor(f.app, f.user, {
    originId: link.originId,
    fullName: link.fullName,
  });
  return opened.ok ? opened.value : undefined;
}

/** What `W` is called on this screen, or undefined when it does not apply. */
export function otherSideLabel(
  f: Session,
  src: RepoSource,
): string | undefined {
  if (src.where.kind === "origin")
    return src.where.mirroredAs === undefined
      ? undefined
      : "the workbench copy";
  const link = src.where.repo.origin;
  if (link === null || f.user === undefined) return undefined;
  return `live on ${hostLabel(link.htmlUrl, link.fullName)}`;
}

/**
 * The upstream this repository forks, when it forks one at an origin.
 *
 * Two rows can say it and they say it about the same thing. A mirror we hold
 * carries `repo.origin_fork_of`, written when `forkOrigin` made it; a live
 * browse has only the picker's cached row for the remote, whose `fork_of` is
 * what the origin itself reported. Either way the answer is `owner/name` at
 * the origin, and "" when this is nobody's fork.
 */
export function forkOf(f: Session, src: RepoSource): string {
  return src.where.kind === "local"
    ? (repoForkOf(f.db, src.where.repo.id) ?? "")
    : (getOriginRepo(f.db, src.where.origin.id, src.where.fullName)?.forkOf ??
        "");
}

/** The branch a screen can open with before `describe()` has answered. */
export const knownDefaultRef = (src: RepoSource): string | undefined =>
  src.where.kind === "local" ? src.where.repo.defaultBranch : undefined;

/** Rows the strip needs: the places, plus the banner on a live browse. */
export const whereRows = (src: RepoSource): number =>
  src.where.kind === "origin" ? 2 : 1;

type Mark = "reading" | "present" | "pinned" | "absent";
/** Which of the three places a row is — what its icon depicts. */
type PlaceKind = "origin" | "workbench" | "machine";

interface Place {
  readonly mark: Mark;
  readonly kind: PlaceKind;
  readonly text: string;
}

/** The three places, in the order the bytes travel: origin → here → laptop. */
export function places(f: Session, src: RepoSource): Place[] {
  const out: Place[] = [];
  if (src.where.kind === "origin") {
    const { origin, mirroredAs } = src.where;
    out.push({ mark: "reading", kind: "origin", text: hostOf(origin.webUrl) });
    out.push(
      mirroredAs === undefined
        ? { mark: "absent", kind: "workbench", text: "workbench" }
        : {
            mark: "present",
            kind: "workbench",
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
      kind: "origin",
      text: hostLabel(link.htmlUrl, link.fullName),
    });
  out.push({
    mark: "reading",
    kind: "workbench",
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
  return {
    mark: pinned ? "pinned" : "absent",
    kind: "machine",
    text: "this machine",
  };
}

const glyphOf = (mark: Mark): string =>
  mark === "absent" ? G.ring : mark === "pinned" ? G.diamond : G.dot;

const colorOf = (c: Tokens, mark: Mark): Color =>
  mark === "reading" ? c.accent : mark === "absent" ? c.faint : c.success;

/**
 * The strip as spans, so a caller can measure it before it paints.
 *
 * The dot keeps its meaning — accent is where these bytes came from — and a
 * Nerd Font session gets one more glyph beside it saying *what kind of place*
 * this is: a globe, a repository, a terminal. That is additive on purpose;
 * the grammar a reader learned in the plain set is still the grammar.
 */
export function whereSpans(
  f: Session,
  src: RepoSource,
  c: Tokens,
  set: IconSet = "plain",
): Span[] {
  const spans: Span[] = [];
  places(f, src).forEach((place, i) => {
    if (i > 0) spans.push({ text: "  ·  ", style: style(c.faint, c.bg) });
    spans.push({
      text: glyphOf(place.mark),
      style: style(colorOf(c, place.mark), c.bg),
    });
    if (set === "nerd")
      spans.push({
        text: ` ${icon(PLACE_ICONS[place.kind], set)}`,
        style: style(place.mark === "reading" ? c.fg : c.mutedFg, c.bg),
      });
    spans.push({
      text: ` ${place.text}`,
      style: style(place.mark === "reading" ? c.fg : c.mutedFg, c.bg),
    });
  });
  spans.push(...tailSpans(f, src, c));
  return spans;
}

/**
 * `· fork of octo/widgets` — the one fact the three dots cannot carry.
 *
 * A fork looks exactly like any other repository in the strip, and knowing
 * whose work it descends from is the difference between "my copy" and "the
 * place I propose changes to". It goes after the places rather than inside
 * them, so `whereLayout`'s arithmetic (and every hit box built from it) is
 * untouched: nothing here is clickable.
 */
function tailSpans(f: Session, src: RepoSource, c: Tokens): Span[] {
  const upstream = forkOf(f, src);
  if (upstream === "") return [];
  return [
    { text: "  ·  ", style: style(c.faint, c.bg) },
    { text: `fork of ${upstream}`, style: style(c.mutedFg, c.bg) },
  ];
}

/**
 * Where each place landed, so a screen can make them clickable.
 *
 * The arithmetic mirrors `whereSpans` exactly, and it has to: a hit box that
 * disagrees with the glyph under it is worse than no hit box. Keeping them in
 * one file, next to each other, is the cheapest way to keep them honest.
 */
export function whereLayout(
  f: Session,
  src: RepoSource,
  r: Rect,
  set: IconSet = "plain",
): { kind: PlaceKind; rect: Rect }[] {
  const out: { kind: PlaceKind; rect: Rect }[] = [];
  let x = r.x;
  places(f, src).forEach((place, i) => {
    if (i > 0) x += 5; // "  ·  "
    const w = 1 + (set === "nerd" ? 2 : 0) + 1 + displayWidth(place.text);
    out.push({ kind: place.kind, rect: { x, y: r.y, w, h: 1 } });
    x += w;
  });
  return out;
}

const PLACE_ICONS: Readonly<Record<PlaceKind, IconName>> = {
  origin: "origin",
  workbench: "repo",
  machine: "terminal",
};

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
  set: IconSet = "plain",
): void {
  if (r.w <= 0 || r.h <= 0) return;
  s.spans(r.x, r.y, whereSpans(f, src, c, set), r.x + r.w);
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
