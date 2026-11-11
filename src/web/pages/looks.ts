/**
 * The look on the web (docs/APPS.md, "The look"): the pictures the forge
 * took of an environment, served with the repository's own read access,
 * and the three places they appear — the pull page, under the checks; the
 * studio's ask row, as a thumbnail; the app's studio head, as how it looks
 * now. A picture is named by the commit it is of, so it is cached for as
 * long as anyone likes and is never the wrong commit's.
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { jpegHeader } from "../../design/image/jpeg.ts";
import { isPng, pngHeader } from "../../design/image/png.ts";
import { join } from "node:path";
import { isEnvName, previewEnv } from "../../apps/data.ts";
import type { AppRecord } from "../../core/apps.ts";
import { getAppByRepo } from "../../core/apps.ts";
import {
  DEFAULT_PAGE,
  isAttached,
  LOOK_SIZES,
  lookSlot,
  looksForEnv,
  type Look,
  type LookKind,
  lookUrl,
  lookVersion,
} from "../../core/looks.ts";
import type { Pull } from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { notFound } from "../../http/respond.ts";
import { pairCounts, pairsLine } from "../../looks/pairs.ts";
import { mayFetchLook as mayFetchLookFor } from "../../looks/readable.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { disclosure, sha, time } from "../ui.ts";

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
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  const env = ctx.params.env ?? "";
  const commit = ctx.params.commit ?? "";
  const slot = ctx.params.kind ?? "";
  if (!repo || !isEnvName(env) || !/^[0-9a-f]{40}$/.test(commit) || slot === "")
    return notFound();
  const found = timePhase(ctx.request, "look", () => {
    const record = getAppByRepo(ctx.app.db, repo.id);
    if (!record) return undefined;
    const look = looksForEnv(ctx.app.db, record.id, env, "any").find(
      (l) => l.commitOid === commit && lookSlot(l.page, l.kind, l.theme) === slot,
    );
    if (look === undefined || look.error !== null) return undefined;
    if (!mayFetchLook(ctx, repo, record, look)) return undefined;
    return look;
  });
  if (found === undefined) return notFound();
  const look = found;
  const path = join(ctx.app.config.dataDir, look.path);
  if (!timePhase(ctx.request, "read", () => existsSync(path))) return notFound();
  const headers = {
    "content-type": path.endsWith(".jpg") ? "image/jpeg" : "image/png",
    // Named by this taking (`lookVersion`), so a retake at the same commit
    // is a new tag as well as a new URL.
    etag: `"${lookVersion(look)}"`,
    // Kept for good only under the name of this taking; asked for by its
    // bare name, it is checked again every time, so a retake at the same
    // commit is never hidden behind a cached old one.
    "cache-control":
      ctx.url.searchParams.get("v") === lookVersion(look)
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
  };
  // Only after `mayFetchLook`: a 304 must not say a private picture exists.
  if (ctx.request.headers.get("if-none-match") === headers.etag)
    return new Response(null, { status: 304, headers });
  return new Response(Bun.file(path), { headers });
}

/** `mayFetchLook` for a request (`looks/readable.ts`). */
export const mayFetchLook = (
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
  look: Look,
): boolean => mayFetchLookFor(ctx.app, repo, record, look, ctx.auth.user);

/**
 * The Look block on a pull: phone and desktop side by side, the commit
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
  // phone or desktop picture taken as nobody (a public app's), and no block
  // without one.
  const writer = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const every = looksForEnv(ctx.app.db, record.id, env, "any").filter(
    (l) =>
      writer ||
      (l.kind !== "thumb" && l.error === null && mayFetchLook(ctx, repo, record, l)),
  );
  // The dark pictures sit beside the light ones, never in place of them.
  const dark = every.filter((l) => l.theme === "dark");
  const looks = every.filter((l) => l.theme === "light");
  if (!writer && looks.length === 0) return html``;
  const attached = looks.filter(isAttached).reverse();
  const taken = looks.filter((l) => !isAttached(l));
  // A block under an h2, the home page's language — not a card.
  const block = (body: Html): Html =>
    html`<section class="settings-block" id="look" data-look-block>
      <h2>Look</h2>
      ${body}
    </section>`;
  if (taken.length === 0 && attached.length === 0) {
    if (pull.state !== "open" || pull.mergedAt !== null) return html``;
    return block(
      html`<p class="muted small">
        No picture yet. One is taken when the preview comes up green.
      </p>`,
    );
  }
  // Home first, then the rest in the order the manifest is likeliest to
  // read them — alphabetically, since the row order says nothing about it.
  const pages = [...new Set(taken.map((l) => l.page))].sort((a, b) =>
    a === DEFAULT_PAGE ? -1 : b === DEFAULT_PAGE ? 1 : a.localeCompare(b),
  );
  const labelled = pages.length > 1;
  // What main looks like, to set each page beside: only what this viewer may fetch.
  const mainLooks = looksForEnv(ctx.app.db, record.id, "production", "any").filter(
    (l) => !isAttached(l) && mayFetchLook(ctx, repo, record, l),
  );
  const picture = (
    look: Look,
    kind: LookKind,
    page: string,
    of = `#${pull.number}`,
  ): Html => {
    const url = lookUrl(base, look);
    const scheme = look.theme === "dark" ? " in the dark" : "";
    return html`<a class="look" data-slot="${kind}" href="${url}">
      <img
        src="${url}"
        width="${LOOK_SIZES[kind].width}"
        height="${LOOK_SIZES[kind].height}"
        alt="${repo.name}${page === DEFAULT_PAGE
          ? ""
          : ` ${page}`} ${of} on a ${kind}${scheme}"
        loading="lazy"
      />
    </a>`;
  };
  const group = (page: string): Html => {
    const looksOfPage = taken.filter((l) => l.page === page);
    const phone = pictured(looksOfPage, "phone");
    const desktop = pictured(looksOfPage, "desktop");
    const failed = looksOfPage.find(
      (l) => l.commitOid === headOid && l.error !== null,
    );
    const label = when(labelled, () =>
      html`<p class="muted small">${page}</p>`,
    );
    const shown = phone ?? desktop;
    if (shown === undefined)
      return html`<section class="stack stack-tight">
        ${label}
        <p class="muted small">
          ${failed === undefined
            ? "No picture yet. One is taken when the preview comes up green."
            : html`No picture of ${sha(headOid)}: ${failed.error}.`}
        </p>
      </section>`;
    const moved = shown.commitOid !== headOid;
    // Beside the same page at the same width and theme: a width main lacks is left out.
    const mainOfPage = mainLooks.filter((l) => l.page === page);
    const beforeOf = (theme: Look["theme"], headKinds: readonly Look["kind"][]): Look[] =>
      headKinds
        .map((kind) => pictured(mainOfPage.filter((l) => l.theme === theme), kind))
        .filter((l): l is Look => l !== undefined);
    const beforeShown = beforeOf("light", [phone, desktop].filter((l) => l !== undefined).map((l) => l.kind));
    // Only the dark pictures of the commit the caption names: after a push
    // the light pair is retaken first, and an old head's dark pair must not
    // sit under the new head's words.
    const darkOfPage = dark.filter(
      (l) => l.page === page && l.commitOid === shown.commitOid,
    );
    const darkPhone = pictured(darkOfPage, "phone");
    const darkDesktop = pictured(darkOfPage, "desktop");
    // Main's picture beside the head's; where main has none, the head stands alone.
    const compare = (before: readonly Look[], after: readonly Look[]): Html =>
      before.length === 0
        ? html`<div class="looks">
              ${after.map((l) => picture(l, l.kind, page))}
            </div>
            <p class="muted small" data-no-main>
              main has no picture of ${page === DEFAULT_PAGE ? "this page" : page} yet.
            </p>`
        : html`<div class="looks" data-compare>
            <div>
              <p class="muted small">main</p>
              <div class="looks">
                ${before.map((l) => picture(l, l.kind, page, "main"))}
              </div>
              <p class="muted small">
                at ${sha(before[0]!.commitOid, `${base}/commit/${before[0]!.commitOid}`)} ·
                ${time(before[0]!.createdAt)}
              </p>
            </div>
            <div>
              <p class="muted small">this pull</p>
              <div class="looks">
                ${after.map((l) => picture(l, l.kind, page))}
              </div>
            </div>
          </div>`;
    const lightAfter = [phone, desktop].filter((l): l is Look => l !== undefined);
    const darkAfter = [darkPhone, darkDesktop].filter((l): l is Look => l !== undefined);
    return html`<section class="stack stack-tight">
      ${label}
      ${compare(beforeShown, lightAfter)}
      ${when(darkAfter.length > 0, () =>
        disclosure(
          "In the dark",
          compare(beforeOf("dark", darkAfter.map((l) => l.kind)), darkAfter),
          { small: true },
        ),
      )}
      <p class="muted small">
        at ${sha(shown.commitOid, `${base}/commit/${shown.commitOid}`)} ·
        ${time(shown.createdAt)}${when(
          moved,
          () =>
            html` · the head has moved
            since${failed === undefined
              ? html`; a new picture follows its deploy`
              : html`; no picture of ${sha(headOid)}: ${failed.error}`}`,
        )}
      </p>
    </section>`;
  };
  // What people attached sits in the same strip, each with its line and
  // who put it there. Their size is their own: the picture's, not a window's.
  const person = (look: Look): Html => {
    const url = lookUrl(base, look);
    const size = attachedSize(ctx, look);
    return html`<figure data-slot="${look.kind}">
      <a class="look" href="${url}">
        <img
          src="${url}"
          ${size === undefined ? html`` : html`width="${size.width}" height="${size.height}"`}
          alt="${look.note ?? ""}"
          loading="lazy"
        />
      </a>
      <figcaption class="muted small">
        ${look.note ?? ""} · ${look.kind} · attached by ${look.attachedBy ?? ""}
        ${time(look.createdAt)}
      </figcaption>
    </figure>`;
  };
  // One line over the pictures, counted from the data `compare` uses.
  const line = pairsLine(pairCounts(taken, mainLooks));
  const summary = line === undefined
    ? html``
    : html`<p class="muted small" data-pairs>${line}</p>`;
  return block(
    html`<div class="stack">
      ${summary}${pages.map(group)}${when(attached.length > 0, () =>
        html`<div class="looks">${attached.map(person)}</div>`,
      )}
    </div>`,
  );
}

/** An attached picture's own size, read from its header; none if it cannot be. */
function attachedSize(
  ctx: Ctx,
  look: Look,
): { width: number; height: number } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(ctx.app.config.dataDir, look.path), "r");
    const head = new Uint8Array(65536);
    const n = readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, n);
    const parsed = isPng(bytes) ? pngHeader(bytes) : jpegHeader(bytes);
    return parsed.ok
      ? { width: parsed.value.width, height: parsed.value.height }
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
    class="look" data-slot="now"
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

/** A small picture as a thumbnail that opens the pull; `label` names the link for a screen reader. */
export function lookThumb(href: string, src: string, label?: string): Html {
  return html`<a class="look" data-slot="thumb" href="${href}" ${label === undefined ? html`` : html`aria-label="${label}"`}
    ><img src="${src}" width="30" height="40" alt="" loading="lazy"
  /></a>`;
}

/** A small picture that is only a picture: named, not a link. */
export function lookThumbPlain(src: string, label: string): Html {
  return html`<span class="look" data-slot="thumb"
    ><img src="${src}" width="30" height="40" alt="${label}" loading="lazy"
  /></span>`;
}
