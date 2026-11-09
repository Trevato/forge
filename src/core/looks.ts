/**
 * Looks — the pictures the forge takes of an environment once its deploy
 * is green (docs/APPS.md, "The look"). One row per picture: which app and
 * environment, at which commit, at which width, where the file is, or why
 * there is none. Pure data: no authz, no events, no files.
 */

import type { Database } from "bun:sqlite";
import { id as newId } from "../kernel/id.ts";

/** The three widths a page is pictured at. */
export type LookKind = "phone" | "desktop" | "thumb";
export const LOOK_KINDS: readonly LookKind[] = ["phone", "desktop", "thumb"];
export const isLookKind = (value: string): value is LookKind =>
  (LOOK_KINDS as readonly string[]).includes(value);

/**
 * The three sizes a picture is kept at, as a person holds them: a phone, a
 * laptop's window, and a thumbnail — the desktop page reduced to half its
 * width, sharp in a tile on a phone or a desktop at twice the pixels.
 */
export const LOOK_SIZES: Readonly<
  Record<LookKind, { readonly width: number; readonly height: number }>
> = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
  thumb: { width: 640, height: 400 },
};

/**
 * The window each picture is taken in. A thumb is the desktop page, taken
 * whole and reduced: a browser does not lay a page out in a window the
 * size of a tile (headless Chromium keeps a minimum width, and pictures a
 * corner of a wider page).
 */
export const LOOK_WINDOWS: Readonly<
  Record<LookKind, { readonly width: number; readonly height: number }>
> = {
  phone: LOOK_SIZES.phone,
  desktop: LOOK_SIZES.desktop,
  thumb: LOOK_SIZES.desktop,
};

/**
 * The width of a thumb taken in a 200×125 window, before thumbs were the
 * desktop page reduced: a corner of the page, cropped, taken as the owner.
 * One at this width is retaken the next time its app is up.
 */
export const LEGACY_THUMB_WIDTH = 200;

/**
 * Which colour scheme a picture was taken in. Every look from before dark
 * pictures existed is light; a dark one is taken with the page's
 * `prefers-color-scheme` forced to dark.
 */
export type LookTheme = "light" | "dark";
export const LOOK_THEMES: readonly LookTheme[] = ["light", "dark"];
export const DEFAULT_THEME: LookTheme = "light";

/** The kinds also pictured in the dark: a thumb is the desktop page reduced, and stays light. */
export const DARK_KINDS: readonly LookKind[] = ["phone", "desktop"];

/** A look with no page recorded — every row before `app.looks` existed. */
export const DEFAULT_PAGE = "/";

/**
 * The page flattened to a filename/URL fragment: the home page is empty
 * (so it names nothing, below), any other path has its slashes joined
 * with `-`. Compared against, never parsed back — the database's `page`
 * column is truth.
 */
const pageSlug = (page: string): string =>
  page === DEFAULT_PAGE ? "" : page.slice(1).replace(/[/#]/g, "-");

/**
 * The fragment one picture is named by, on disk and in its URL: the page
 * and the kind, or — for the home page — the kind alone, exactly as
 * before `app.looks` existed, so two pages of one commit never collide
 * and old names keep meaning what they always meant.
 */
export const lookSlot = (
  page: string,
  kind: LookKind,
  theme: LookTheme = DEFAULT_THEME,
): string => {
  const slug = pageSlug(page);
  const base = slug === "" ? kind : `${slug}-${kind}`;
  return theme === "dark" ? `${base}-dark` : base;
};

export interface Look {
  readonly id: string;
  readonly appId: string;
  readonly env: string;
  readonly commitOid: string;
  /** The page pictured — `forge.json`'s `app.looks`, `/` when unset. */
  readonly page: string;
  readonly kind: LookKind;
  /** The colour scheme it was taken in; light for every look before dark ones. */
  readonly theme: LookTheme;
  /** Where the picture is, relative to the data directory; empty on an error. */
  readonly path: string;
  readonly createdAt: string;
  /** Why there is no picture, when there is none. */
  readonly error: string | null;
  /** Who the picture was taken as: the owner (an admin), or nobody. */
  readonly takenAs: "owner" | "nobody";
  /** The person who attached it, for a look the forge did not take. */
  readonly attachedBy: string | null;
  /** The one line that says what an attached look shows. */
  readonly note: string | null;
  /** The page's own size when it was pictured; absent when it was not kept. */
  readonly size?: LookSize;
}

/** The document's scroll size and the window's inner size, in CSS pixels. */
export interface LookSize {
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

interface Row {
  id: string;
  app_id: string;
  env: string;
  commit_oid: string;
  page: string;
  kind: LookKind;
  theme: LookTheme;
  path: string;
  created_at: string;
  error: string | null;
  taken_as: "owner" | "nobody";
  attached_by: string | null;
  note: string | null;
  scroll_width: number | null;
  scroll_height: number | null;
  inner_width: number | null;
  inner_height: number | null;
}

/**
 * The `page` column of a dark look. The table's unique key is (app, env,
 * commit, page, kind) and a roll never rebuilds it (migrations are
 * additive while an older process still serves), so a dark look is filed
 * under a page no light one can have — pages start with `/` — and this
 * module is the only place that knows.
 */
const DARK_PREFIX = "dark:";
const stored = (page: string, theme: LookTheme): string =>
  theme === "dark" ? `${DARK_PREFIX}${page}` : page;
const unstored = (page: string): string =>
  page.startsWith(DARK_PREFIX) ? page.slice(DARK_PREFIX.length) : page;

const sizeOf = (r: Row): { size: LookSize } | undefined =>
  r.scroll_width === null ||
  r.scroll_height === null ||
  r.inner_width === null ||
  r.inner_height === null
    ? undefined
    : {
        size: {
          scrollWidth: r.scroll_width,
          scrollHeight: r.scroll_height,
          innerWidth: r.inner_width,
          innerHeight: r.inner_height,
        },
      };

const toLook = (r: Row): Look => ({
  id: r.id,
  appId: r.app_id,
  env: r.env,
  commitOid: r.commit_oid,
  page: unstored(r.page),
  kind: r.kind,
  theme: r.theme,
  path: r.path,
  createdAt: r.created_at,
  error: r.error,
  takenAs: r.taken_as,
  attachedBy: r.attached_by,
  note: r.note,
  ...sizeOf(r),
});

export interface RecordLookInput {
  readonly appId: string;
  readonly env: string;
  readonly commitOid: string;
  readonly page?: string | undefined;
  readonly kind: LookKind;
  readonly theme?: LookTheme | undefined;
  readonly path: string;
  readonly error?: string | undefined;
  /** Who it was taken as; the owner unless said. */
  readonly takenAs?: "owner" | "nobody" | undefined;
  /** A person's attachment: who, and what it shows. */
  readonly attachedBy?: string | undefined;
  readonly note?: string | undefined;
  /** What the page reported of its size; none stores nulls. */
  readonly size?: LookSize | undefined;
}

/** Record a picture, or the reason there is none. A retake replaces. */
export function recordLook(db: Database, input: RecordLookInput): Look {
  const page = input.page ?? DEFAULT_PAGE;
  const theme = input.theme ?? DEFAULT_THEME;
  db.query(
    `INSERT INTO look (id, app_id, env, commit_oid, page, kind, path, error, taken_as, attached_by, note, theme,
       scroll_width, scroll_height, inner_width, inner_height)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
     ON CONFLICT (app_id, env, commit_oid, page, kind) DO UPDATE SET
       path = excluded.path, error = excluded.error, taken_as = excluded.taken_as,
       scroll_width = excluded.scroll_width, scroll_height = excluded.scroll_height,
       inner_width = excluded.inner_width, inner_height = excluded.inner_height,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    newId(),
    input.appId,
    input.env,
    input.commitOid,
    stored(page, theme),
    input.kind,
    input.path,
    input.error ?? null,
    input.takenAs ?? "owner",
    input.attachedBy ?? null,
    input.note ?? null,
    theme,
    input.size?.scrollWidth ?? null,
    input.size?.scrollHeight ?? null,
    input.size?.innerWidth ?? null,
    input.size?.innerHeight ?? null,
  );
  return getLook(db, input.appId, input.env, input.commitOid, page, input.kind, theme)!;
}

export function getLook(
  db: Database,
  appId: string,
  env: string,
  commitOid: string,
  page: string,
  kind: LookKind,
  theme: LookTheme = DEFAULT_THEME,
): Look | undefined {
  const row = db
    .query<
      Row,
      [string, string, string, string, string]
    >(`SELECT * FROM look WHERE app_id = ?1 AND env = ?2 AND commit_oid = ?3 AND page = ?4 AND kind = ?5`)
    .get(appId, env, commitOid, stored(page, theme), kind);
  return row ? toLook(row) : undefined;
}

/**
 * Every look of one environment, newest first. The light ones unless
 * `theme` says otherwise (`"any"` for both): what shows a page's picture
 * has always meant the light one.
 */
export function looksForEnv(
  db: Database,
  appId: string,
  env: string,
  theme: LookTheme | "any" = DEFAULT_THEME,
): Look[] {
  return db
    .query<
      Row,
      [string, string, string]
    >(`SELECT * FROM look WHERE app_id = ?1 AND env = ?2 AND (?3 = 'any' OR theme = ?3) ORDER BY created_at DESC, kind, theme`)
    .all(appId, env, theme)
    .map(toLook);
}

/** Every light look of several apps in one read, newest first. */
export function looksForApps(db: Database, appIds: readonly string[]): Look[] {
  const out: Look[] = [];
  const unique = [...new Set(appIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<Row, string[]>(
        `SELECT * FROM look WHERE theme = 'light' AND app_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         ORDER BY created_at DESC, kind`,
      )
      .all(...batch);
    for (const row of rows) out.push(toLook(row));
  }
  return out;
}

/**
 * Every picture taken of some commits, in any environment and either
 * theme, newest first: what a pin's screenshots are picked from. Errors
 * are left out; a person picks only what is there.
 */
export function looksForCommits(db: Database, commitOids: readonly string[]): Look[] {
  const out: Look[] = [];
  const unique = [...new Set(commitOids)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<Row, string[]>(
        `SELECT * FROM look WHERE error IS NULL AND commit_oid IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         ORDER BY created_at DESC, kind, theme`,
      )
      .all(...batch);
    for (const row of rows) out.push(toLook(row));
  }
  return out;
}

/**
 * Forget an environment's looks — all of them, or all but one commit's
 * (a person's attachments are not the forge's to age out: they go with the
 * environment).
 * Returns what was forgotten, so the files can go with the rows.
 */
export function deleteLooks(
  db: Database,
  appId: string,
  env: string,
  keepCommit?: string,
): Look[] {
  const gone =
    keepCommit === undefined
      ? db
          .query<
            Row,
            [string, string]
          >(`DELETE FROM look WHERE app_id = ?1 AND env = ?2 RETURNING *`)
          .all(appId, env)
      : db
          .query<
            Row,
            [string, string, string]
          >(`DELETE FROM look WHERE app_id = ?1 AND env = ?2 AND commit_oid != ?3 AND attached_by IS NULL RETURNING *`)
          .all(appId, env, keepCommit);
  return gone.map(toLook);
}

/** Delete every thumb of an app that was taken as a stranger; the ones deleted. */
export function deleteStrangerThumbs(db: Database, appId: string): Look[] {
  return db
    .query<
      Row,
      [string]
    >(`DELETE FROM look WHERE app_id = ?1 AND kind = 'thumb' AND taken_as = 'nobody' AND attached_by IS NULL RETURNING *`)
    .all(appId)
    .map(toLook);
}

/**
 * Which taking of a picture this is: a picture retaken at the same commit
 * (a thumb from before thumbs were the page, or one that failed) is a new
 * file under the same name, so the name alone cannot be cached for good.
 */
export const lookVersion = (look: Look): string =>
  look.createdAt.replace(/\D/g, "");

/** Where a picture is served. Named by page and kind, unless the page is
 * the home page, when it is the kind alone — exactly the URL from before
 * `app.looks` existed — and by which taking of it, so a browser that kept
 * the last one for a year asks for the new one. */
export const lookUrl = (base: string, look: Look): string =>
  `${base}/looks/${look.env}/${look.commitOid}/${lookSlot(look.page, look.kind, look.theme)}.png?v=${lookVersion(look)}`;

/** Whether a look was attached by a person, not taken by the forge. */
export const isAttached = (look: Look): boolean => look.attachedBy !== null;

/** The page an attached look is filed under: its own, so it never collides. */
export const attachedPage = (id: string): string => `/attached-${id}`;
