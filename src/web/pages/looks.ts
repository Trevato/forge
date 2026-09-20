/**
 * The look on the web (docs/APPS.md, "The look"): the pictures the forge
 * took of an environment, served with the repository's own read access,
 * and the three places they appear — the pull page, under the checks; the
 * studio's ask row, as a thumbnail; the app's studio head, as how it looks
 * now. A picture is named by the commit it is of, so it is cached for as
 * long as anyone likes and is never the wrong commit's.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isEnvName, previewEnv, type EnvName } from "../../apps/data.ts";
import type { AppRecord } from "../../core/apps.ts";
import { getAppByRepo } from "../../core/apps.ts";
import {
  getLook,
  isLookKind,
  LOOK_SIZES,
  looksForEnv,
  type Look,
  type LookKind,
} from "../../core/looks.ts";
import type { Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { notFound } from "../../http/respond.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { card, icon, sha, time } from "../ui.ts";

/** Where a picture is served. */
export const lookUrl = (
  base: string,
  env: EnvName,
  commitOid: string,
  kind: LookKind,
): string => `${base}/looks/${env}/${commitOid}/${kind}.png`;

/** The newest picture at one width, when there is one. */
const pictured = (looks: readonly Look[], kind: LookKind): Look | undefined =>
  looks.find((l) => l.kind === kind && l.error === null);

/**
 * The picture for a small slot: the dedicated thumb, or — for a commit
 * taken before it existed — the phone shot a thumbnail loaded before.
 */
export const thumbLook = (looks: readonly Look[]): Look | undefined =>
  pictured(looks, "thumb") ?? pictured(looks, "phone");

// GET /:owner/:name/looks/:env/:commit/:kind.png
export function lookImage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  const env = ctx.params.env ?? "";
  const commit = ctx.params.commit ?? "";
  const kind = ctx.params.kind ?? "";
  if (
    !repo ||
    !isEnvName(env) ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !isLookKind(kind)
  )
    return notFound();
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (!record) return notFound();
  const look = getLook(ctx.app.db, record.id, env, commit, kind);
  if (look === undefined || look.error !== null) return notFound();
  const path = join(ctx.app.config.dataDir, look.path);
  if (!existsSync(path)) return notFound();
  return new Response(Bun.file(path), {
    headers: {
      "content-type": "image/png",
      // Named by its commit: the same URL never shows a different picture.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

/**
 * The Look card on a pull: phone and desktop side by side, the commit
 * they are of, and a word when the head has moved since — or, honestly,
 * why there is no picture. Nothing once the preview is gone.
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
  const looks = looksForEnv(ctx.app.db, record.id, env);
  const phone = pictured(looks, "phone");
  const desktop = pictured(looks, "desktop");
  const failed = looks.find((l) => l.commitOid === headOid && l.error !== null);
  const head = html`${icon("eye")}
    <h2>Look</h2>`;
  const shown = phone ?? desktop;
  if (shown === undefined) {
    if (pull.state !== "open" || pull.mergedAt !== null) return html``;
    return card(
      html`<p class="muted small">
        ${failed === undefined
          ? "No picture yet. One is taken when the preview comes up green."
          : html`No picture of ${sha(headOid)}: ${failed.error}.`}
      </p>`,
      { head, extra: "look-card" },
    );
  }
  const moved = shown.commitOid !== headOid;
  const picture = (look: Look, kind: LookKind): Html => {
    const url = lookUrl(base, env, look.commitOid, kind);
    return html`<a class="look look-${kind}" href="${url}">
      <img
        src="${url}"
        width="${LOOK_SIZES[kind].width}"
        height="${LOOK_SIZES[kind].height}"
        alt="${repo.name} #${pull.number} on a ${kind}"
        loading="lazy"
      />
    </a>`;
  };
  return card(
    html`<div class="look-pair">
      ${when(phone, (l) => picture(l, "phone"))}
      ${when(desktop, (l) => picture(l, "desktop"))}
    </div>`,
    {
      head: html`${head}
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
        >`,
      extra: "look-card",
    },
  );
}

/**
 * How production looks now, small, for the app's studio head — the
 * dedicated thumb, or a commit from before it existed still shows what it
 * always showed. It is the first picture on the app's own page, so it is
 * not lazy: a person opening the app wants to see it at once.
 */
export function lookNow(ctx: Ctx, repo: Repo, record: AppRecord): Html {
  const looks = looksForEnv(ctx.app.db, record.id, "production");
  const look = pictured(looks, "thumb") ?? pictured(looks, "desktop");
  if (look === undefined) return html``;
  const base = repoBase(repo);
  const size = LOOK_SIZES[look.kind];
  return html`<a
    class="look-now"
    href="${base}/app/production/open"
    title="How it looks now, at ${look.commitOid.slice(0, 7)}"
  >
    <img
      src="${lookUrl(base, "production", look.commitOid, look.kind)}"
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
