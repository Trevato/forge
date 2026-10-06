/**
 * The look on the web (docs/APPS.md, "The look"): the pictures the forge
 * took of an environment, served with the repository's own read access,
 * and the three places they appear — the pull page, under the checks; the
 * studio's ask row, as a thumbnail; the app's studio head, as how it looks
 * now. A picture is named by the commit it is of, so it is cached for as
 * long as anyone likes and is never the wrong commit's.
 */

import { sealedPreview } from "../../core/sealed.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isEnvName, previewEnv } from "../../apps/data.ts";
import type { AppRecord } from "../../core/apps.ts";
import { getAppByRepo } from "../../core/apps.ts";
import {
  DEFAULT_PAGE,
  LOOK_SIZES,
  lookSlot,
  looksForEnv,
  type Look,
  type LookKind,
  lookUrl,
  lookVersion,
} from "../../core/looks.ts";
import type { Pull } from "../../core/pulls.ts";
import { canEnterApp, canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { notFound } from "../../http/respond.ts";
import { keepLook } from "../../looks/service.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { card, icon, sha, time } from "../ui.ts";

/** The newest picture at one width, when there is one. */
export const pictured = (
  looks: readonly Look[],
  kind: LookKind,
): Look | undefined => looks.find((l) => l.kind === kind && l.error === null);

/**
 * The picture for a small slot: the dedicated thumb, or — for a commit
 * taken before it existed — the phone shot a thumbnail loaded before,
 * whichever this viewer may fetch (`mayFetchLook`: the phone shot is the
 * owner's view, so a reader gets the thumb or nothing, never a broken
 * image). Always the home page: a slot this small has room for one picture
 * of an app, and the home page is the one everyone means by it.
 */
export function thumbLook(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
  looks: readonly Look[],
): Look | undefined {
  const home = looks.filter((l) => l.page === DEFAULT_PAGE);
  return [pictured(home, "thumb"), pictured(home, "phone")].find(
    (l) => l !== undefined && mayFetchLook(ctx, repo, record, l),
  );
}

// GET /:owner/:name/looks/:env/:commit/:kind.png — the last segment is
// really a slot (`lookSlot`): the kind alone for the home page, the page
// and the kind for any other.
export function lookImage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  const env = ctx.params.env ?? "";
  const commit = ctx.params.commit ?? "";
  const slot = ctx.params.kind ?? "";
  if (!repo || !isEnvName(env) || !/^[0-9a-f]{40}$/.test(commit) || slot === "")
    return notFound();
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (!record) return notFound();
  const look = looksForEnv(ctx.app.db, record.id, env).find(
    (l) => l.commitOid === commit && lookSlot(l.page, l.kind) === slot,
  );
  if (look === undefined || look.error !== null) return notFound();
  if (!mayFetchLook(ctx, repo, record, look)) return notFound();
  const path = join(ctx.app.config.dataDir, look.path);
  if (!existsSync(path)) return notFound();
  return new Response(Bun.file(path), {
    headers: {
      "content-type": "image/png",
      // Kept for good only under the name of this taking (`lookVersion`);
      // asked for by its bare name, it is checked again every time, so a
      // retake at the same commit is never hidden behind a cached old one.
      "cache-control":
        ctx.url.searchParams.get("v") === lookVersion(look)
          ? "private, max-age=31536000, immutable"
          : "private, no-cache",
    },
  });
}

/**
 * Who may fetch a picture (#727, #738). Writers, all of them. Anyone else
 * only what was taken as nobody, and only of an app they may open (anyone
 * for a public app, a writer, the crew or a named person for a private
 * one): the thumb always, a public app's phone and desktop too. A picture
 * taken as the owner, an admin, stays the writers'; so does a thumb from
 * before thumbs were taken as nobody (`keepLook`), until it is retaken.
 */
export function mayFetchLook(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
  look: Look,
): boolean {
  const user = ctx.auth.user;
  if (canSeeOwnerFacts(ctx.app.db, repo, user)) return true;
  // A sealed pull's pictures are the writers' (`core/sealed.ts`).
  if (sealedPreview(ctx.app.db, repo.id, look.env)) return false;
  // A private app's pictures are for whoever may enter it (#620, #752): a
  // person it names sees them; a reader who is not named does not.
  if (!canEnterApp(ctx.app.db, repo, record, user)) return false;
  // Phone and desktop are a reader's only when taken as nobody — a public
  // app's, since #738; one taken as the owner stays the writers' (#727).
  if (look.kind !== "thumb") return look.takenAs === "nobody";
  return keepLook(ctx.app.config.dataDir, look);
}

/**
 * The Look card on a pull: phone and desktop side by side, the commit
 * they are of, and a word when the head has moved since — or, honestly,
 * why there is no picture. More than one page in `app.looks` gets one
 * group per page, each labelled by its path, since each can be at a
 * different commit (a page that failed keeps its last good picture while
 * another moves on). Nothing once the preview is gone.
 */
export function lookCard(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
  pull: Pull,
  headOid: string,
): Html {
  const base = repoBase(repo);
  const env = previewEnv(pull.number);
  // What this viewer may see: all of it for a writer; for a reader, only a
  // phone or desktop picture taken as nobody (a public app's), and no card
  // without one.
  const writer = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const looks = looksForEnv(ctx.app.db, record.id, env).filter(
    (l) =>
      writer ||
      (l.kind !== "thumb" && l.error === null && mayFetchLook(ctx, repo, record, l)),
  );
  if (!writer && looks.length === 0) return html``;
  const head = html`${icon("eye")}
    <h2>Look</h2>`;
  if (looks.length === 0) {
    if (pull.state !== "open" || pull.mergedAt !== null) return html``;
    return card(
      html`<p class="muted small">
        No picture yet. One is taken when the preview comes up green.
      </p>`,
      { head, extra: "look-card" },
    );
  }
  // Home first, then the rest in the order the manifest is likeliest to
  // read them — alphabetically, since the row order says nothing about it.
  const pages = [...new Set(looks.map((l) => l.page))].sort((a, b) =>
    a === DEFAULT_PAGE ? -1 : b === DEFAULT_PAGE ? 1 : a.localeCompare(b),
  );
  const labelled = pages.length > 1;
  const picture = (look: Look, kind: LookKind, page: string): Html => {
    const url = lookUrl(base, look);
    return html`<a class="look look-${kind}" href="${url}">
      <img
        src="${url}"
        width="${LOOK_SIZES[kind].width}"
        height="${LOOK_SIZES[kind].height}"
        alt="${repo.name}${page === DEFAULT_PAGE
          ? ""
          : ` ${page}`} #${pull.number} on a ${kind}"
        loading="lazy"
      />
    </a>`;
  };
  const group = (page: string): Html => {
    const looksOfPage = looks.filter((l) => l.page === page);
    const phone = pictured(looksOfPage, "phone");
    const desktop = pictured(looksOfPage, "desktop");
    const failed = looksOfPage.find(
      (l) => l.commitOid === headOid && l.error !== null,
    );
    const label = when(labelled, () =>
      html`<p class="muted small look-page">${page}</p>`,
    );
    const shown = phone ?? desktop;
    if (shown === undefined)
      return html`<div class="look-group">
        ${label}
        <p class="muted small">
          ${failed === undefined
            ? "No picture yet. One is taken when the preview comes up green."
            : html`No picture of ${sha(headOid)}: ${failed.error}.`}
        </p>
      </div>`;
    const moved = shown.commitOid !== headOid;
    return html`<div class="look-group">
      ${label}
      <div class="look-pair">
        ${when(phone, (l) => picture(l, "phone", page))}
        ${when(desktop, (l) => picture(l, "desktop", page))}
      </div>
      <span class="muted small look-of"
        >at ${sha(shown.commitOid, `${base}/commit/${shown.commitOid}`)} ·
        ${time(shown.createdAt)}${when(
          moved,
          () =>
            html` · the head has moved
            since${failed === undefined
              ? html`; a new picture follows its deploy`
              : html`; no picture of ${sha(headOid)}: ${failed.error}`}`,
        )}</span
      >
    </div>`;
  };
  return card(
    html`${pages.map(group)}`,
    { head, extra: "look-card" },
  );
}

/**
 * How production looks now, small, for the app's studio head — the
 * dedicated thumb, or a commit from before it existed still shows what it
 * always showed. It is the first picture on the app's own page, so it is
 * not lazy: a person opening the app wants to see it at once.
 */
export function lookNow(ctx: Ctx, repo: Repo, record: AppRecord): Html {
  const looks = looksForEnv(ctx.app.db, record.id, "production").filter(
    (l) => l.page === DEFAULT_PAGE,
  );
  // The desktop picture is the owner's view: only a writer falls back to it.
  const look = [pictured(looks, "thumb"), pictured(looks, "desktop")].find(
    (l) => l !== undefined && mayFetchLook(ctx, repo, record, l),
  );
  if (look === undefined) return html``;
  const base = repoBase(repo);
  const size = LOOK_SIZES[look.kind];
  return html`<a
    class="look-now"
    href="${base}/app/production/open"
    title="How it looks now, at ${look.commitOid.slice(0, 7)}"
  >
    <img
      src="${lookUrl(base, look)}"
      width="${size.width}"
      height="${size.height}"
      alt="${repo.name} as it looks now"
    />
  </a>`;
}

/** A small picture as a thumbnail that opens the pull. */
export function lookThumb(href: string, src: string): Html {
  return html`<a class="look-thumb" href="${href}"
    ><img src="${src}" width="30" height="40" alt="" loading="lazy"
  /></a>`;
}
