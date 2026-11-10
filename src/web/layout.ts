/**
 * The page shell. Every page shares one topbar, one stylesheet, and one
 * Content-Security-Policy strict enough that a page must earn any script it
 * ever ships. Pages work with zero JavaScript — enhancement is a later
 * privilege, not a load-bearing wall. That includes the theme switcher (a
 * plain form POST persists the choice), the command palette (a link to
 * `/search`), and every dialog (a link to a real page).
 */

import { NEW_ISSUE_KEY } from "./script_keys.ts";
import { newIssueHref } from "./issue_from.ts";
import { OPENSEARCH_PATH, OPENSEARCH_TITLE, OPENSEARCH_TYPE } from "./opensearch.ts";
import { protectionNotice } from "../kernel/protection.ts";
import { administersAny } from "../core/admin_repos.ts";
import { appsForRepos } from "../core/apps.ts";
import { foundryHref } from "../actions/foundry_door.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { wordClip } from "../text/word_clip.ts";
import { absorbedForNav } from "../actions/features.ts";
import {
  enterableApps,
  getRepo,
  listReposByOwner,
  listReposVisibleTo,
} from "../core/repos.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import type { User } from "../core/users.ts";
import type { Ctx } from "../http/context.ts";
import { activeEdgeToken, edgeLoginUrl, edgeLogoutUrl, edgeStrangerLogin } from "../http/edge.ts";
import { json } from "../http/respond.ts";
import { sha256 } from "../kernel/hash.ts";
import { holds, taggable, weakEtag } from "../http/etag.ts";
import { EDGE_VARY, sharedCache } from "../http/edge_cache.ts";
import { runningLine } from "../kernel/version.ts";
import {
  bootCss,
  metaThemeColor,
  THEME_NAMES,
  THEMES,
  type ThemeName,
} from "../design/themes.ts";
import {
  beaconAsset,
  pageScriptAsset,
  shellAsset,
  speculationAsset,
  spriteAsset,
  stylesheetAsset,
} from "./asset.ts";
import { linkHeader, pageLinks } from "./standards.ts";
import {
  clearFlashCookie,
  flashCookie,
  readFlash,
  type Flash,
} from "./flash.ts";
import { prefersJson } from "./form.ts";
import { notePhase } from "../core/route_timing.ts";
import { html, raw, when, type Html } from "./html.ts";
import { noRoom } from "../spawn/door.ts";
import { quotaFull } from "../spawn/quota.ts";
import { icon, inlineIcons, pointAtSprite, themeGlyph } from "./icons.ts";
import { btn, copyField, hintAttr, kbd, menu, type MenuItem } from "./ui.ts";
import { SITE_LINE } from "./site_line.ts";

/** One row of the command palette: title, href, category. */
export interface PaletteItem {
  t: string;
  h: string;
  c?: string;
  /** A repository's bare name; its app's label and door; whether the viewer owns it. */
  n?: string;
  x?: string;
  o?: string;
  m?: 1;
  /** A mutation: the palette posts these fields to `h`, as the page's own form does. */
  p?: Record<string, string>;
}

export interface PageOptions {
  /** The request: user, theme and flash all come from here. */
  ctx: Ctx;
  /**
   * A flash for this response itself, for a form that re-renders instead of
   * redirecting. It stands in for the cookie's, so a page never shows two.
   */
  flash?: Flash;
  title: string;
  /**
   * One sentence for the places that show a page before it is opened: a
   * search result, a link unfurled in a chat. A repository's description,
   * an issue's first line. Absent, the forge's own line stands in.
   */
  description?: string;
  /**
   * The shell without its column width: a page whose content earns a wide
   * monitor (the code browser, a tree beside a file). The topbar and footer
   * are unchanged; only the main column lets go of `--page`.
   */
  wide?: boolean;
  /**
   * This page's link-preview card, a same-origin path such as
   * `/og/audit.png` (`pages/og.ts`). Only for a page whose card answers a
   * signed-out unfurler; absent, the forge's own card (`/og/site.png`) stands in.
   */
  ogImage?: string | undefined;
  /** This page's feed, advertised in the head so a reader can find it. */
  feed?: { href: string; title: string };
  /** This page's JSON twin, advertised in the head for agents. */
  json?: { href: string; title: string };
  /** Structured data (JSON-LD) for the head, already escaped by `safeJson`. */
  jsonLd?: string;
  /** Breadcrumb segments rendered in the topbar, e.g. owner / repo. */
  crumbs?: { label: string; href: string }[];
  /**
   * What the viewer is looking at, for the header's Talk link: `owner/repo`
   * or `owner/repo#N`. Only a page that rendered that subject for this viewer
   * passes it (repository home, issue, pull); it is never derived from the
   * path, so a 404 and a refusal keep the bare /talk and cannot tell a
   * private repository from a missing one.
   */
  about?: string;
  body: Html;
  /**
   * CSS this request computed: label colors mixed from the labels actually
   * on the page (`labelCss`) are the case this exists for. A rule that is
   * the same for every visitor belongs in the served stylesheet
   * (`web/style.ts`), which the browser already has — the studio's and the
   * board's used to be sent from here and now live there. Emitted in a nonce'd
   * <style> the strict CSP allows. Must be trusted CSS the page generated —
   * never unescaped user text.
   */
  styleCss?: string;
  /**
   * Page-specific JavaScript (progressive enhancement — every page works
   * without it). Emitted in a nonce'd <script>. Must be trusted, static code
   * the page authored, with runtime data passed via `data-*` attributes,
   * never interpolated into the script text.
   */
  scriptJs?: string;
  /**
   * A same-origin script file this page needs (today: the highlighter bundle
   * the editor loads). It is the one thing that relaxes the script CSP — from
   * "this page's nonce only" to "this page's nonce, or a file from this
   * origin" — so pages that do not ask for it keep the stricter policy.
   */
  scriptAsset?: string;
  /**
   * The page compiles WebAssembly (a machine's shell page runs its terminal
   * emulator in it): `script-src` gains `'wasm-unsafe-eval'`, which admits
   * WebAssembly compilation and nothing else — no `eval`, no inline script.
   * Only that page asks; no other page's policy changes.
   */
  wasm?: boolean;
  /**
   * The page draws a PDF from the media route in an `<object>`: the browser's
   * own viewer may load it from this origin (`object-src 'self'`). Only the
   * blob page of a PDF asks; no other page's policy changes.
   */
  objectSrc?: boolean;
  /**
   * The page sets a font file in the font itself (`render/font.ts`): the
   * browser may load a font from this origin (`font-src 'self'`). Only the
   * blob page of a font asks; no other page's policy changes.
   */
  fontSrc?: boolean;
  /**
   * The page carries a Cloudflare Turnstile widget (`/signup`): its script,
   * frame and verification call may come from challenges.cloudflare.com, and
   * nothing else on this page is relaxed.
   */
  turnstile?: boolean;
  /**
   * One more origin this page may frame, as `scheme://host[:port]`: the
   * display origin a captured page plays on. It loosens `frame-src` for this
   * page alone; anything that is not a bare origin is ignored.
   */
  frameSrc?: string | undefined;
  /** Extra palette rows for this page's context (a repo's own tabs). */
  palette?: PaletteItem[];
  /**
   * No topbar, no footer, no page width: a page that is the whole window
   * (the board). The overlays stay, so the palette is still one chord away.
   */
  bare?: boolean;
  /** A visitor's page: what the bar holds in place of search and the menu. */
  tools?: Html;
  /** A visitor's page: what the foot holds in place of its usual line. */
  foot?: Html;
  /** The theme when the viewer has chosen none: for a page that is dark by nature. */
  theme?: ThemeName;
}

// ---- topbar pieces ----

/** The theme choice as a panel section: lives in a menu, never in the bar. */
function themeForm(active: ThemeName | undefined): Html {
  const option = (value: string, label: string, checked: boolean) =>
    html`<label class="check">
      <input
        type="radio"
        name="theme"
        value="${value}"
        ${checked ? raw("checked") : null}
      />
      <span class="swatch" data-t="${value}"></span>
      ${label}
    </label>`;
  return html`<form class="theme-form" method="post" action="/theme">
      <fieldset class="field">
        <legend>Theme</legend>
        ${option("system", "System", active === undefined)}
        ${THEME_NAMES.map((name) =>
          option(name, THEMES[name].label, active === name),
        )}
      </fieldset>
      ${btn("Apply", { size: "sm" })}
    </form>`;
}

/** Keyboard help: js-only, since the shortcuts it lists only exist then. */
const helpItem = html`<button class="menu-item js-only hide-sm" type="button" data-help>
  ${icon("help")}<span class="grow">Keyboard shortcuts</span>
</button>`;

/** Someone not signed in has no user menu; theme and help share this one. */
/**
 * "New issue" from this page, with no script (`c` is the same door): a link
 * in the menus. Read-only origin browse has nowhere to write, so it has none.
 */
const newIssueItem = (ctx: Ctx): MenuItem[] =>
  ctx.url.pathname.startsWith("/origins/")
    ? []
    : [{ label: "New issue", href: newIssueHref(ctx.url.pathname), hint: NEW_ISSUE_KEY }];

function guestMenu(ctx: Ctx, theme: ThemeName | undefined): Html {
  return menu({
    trigger: themeGlyph,
    items: [...newIssueItem(ctx), { label: "Packs", href: "/packs", icon: "rocket" }, helpItem, themeForm(theme)],
    label: "Appearance and help",
    triggerOptions: { extra: "btn-icon" },
  });
}

/** A whole forge for someone (`/forges/new`): any signed-in person's. */
const NEW_FORGE: MenuItem = {
  label: "New forge",
  href: "/forges/new",
  icon: "fork",
};

/** The door shows to every person; with no room left it is disabled and says why. */
const isPerson = (ctx: Ctx): boolean => ctx.auth.user?.kind === "user";
const roomless = (ctx: Ctx): string | undefined =>
  noRoom(ctx.app) ?? quotaFull(ctx.app.config.dataDir);
const sendsForges = (ctx: Ctx): boolean =>
  isPerson(ctx) && roomless(ctx) === undefined;
const forgeDoor = (ctx: Ctx): MenuItem[] => {
  if (!isPerson(ctx)) return [];
  const why = roomless(ctx);
  return [why === undefined ? NEW_FORGE : { ...NEW_FORGE, disabled: why }];
};

function newMenu(ctx: Ctx): Html {
  const items: MenuItem[] = [
    ...newIssueItem(ctx),
    { label: "New app", href: "/apps/new", icon: "rocket" },
    { label: "New repository", href: "/new", icon: "repo" },
    { label: "Migrate", href: "/migrate", icon: "download" },
    { label: "New organization", href: "/organizations/new", icon: "users" },
    ...forgeDoor(ctx),
  ];
  return menu({
    trigger: icon("plus"),
    items,
    label: "Create new",
    title: "Create",
    triggerOptions: { extra: "btn-icon" },
  });
}

/** A summary's longest title: a tooltip, not a paragraph. */
const SUMMARY_TITLE_MAX = 200;

/**
 * The apps absorbed as the forge's own features, for the menu: each
 * opens at its declared page through the forge's door, which vouches for the
 * viewer, so a private feature opens without a second sign-in.
 */
function featureItems(ctx: Ctx, user: User): MenuItem[] {
  const runtime = appsRuntime(ctx.app);
  const entries = absorbedForNav(ctx.app, user).map((f) => {
    // Without a runtime there is no host to open: the app's own page instead.
    const href =
      runtime === undefined
        ? `/${f.repo}`
        : `/apps/open?host=${encodeURIComponent(new URL(runtime.urlFor(f.record, "production")).host)}&to=${encodeURIComponent(f.page)}`;
    const entry: MenuItem = { label: f.name, href, icon: "rocket" };
    return f.summary ? { ...entry, title: wordClip(f.summary, SUMMARY_TITLE_MAX) } : entry;
  });
  // Under a heading of their own, so an app's chosen name cannot pass for a forge item.
  return entries.length === 0
    ? []
    : [{ separator: true, label: "" }, { label: "Features from apps", heading: true }, ...entries];
}

/** `/talk`, or `/talk?about=…` when the page rendered a subject. */
function talkHref(about: string | undefined): string {
  return about === undefined ? "/talk" : `/talk?about=${encodeURIComponent(about).replace(/%2F/g, "/")}`;
}

function userMenu(
  ctx: Ctx,
  user: User,
  theme: ThemeName | undefined,
  signOut: MenuItem,
  about?: string,
): Html {
  const items: (MenuItem | Html)[] = [
    { label: "Your profile", href: `/${user.username}`, icon: "user" },
    { label: "Repositories", href: "/repos", icon: "repo" },
    { label: "Apps", href: "/apps", icon: "rocket" },
    { label: "Notes", href: "/notes", icon: "comment" },
    { label: "Talk", href: talkHref(about), icon: "comment" },
    { label: "Explore", href: "/explore", icon: "search" },
    { label: "Packs", href: "/packs", icon: "rocket" },
    { label: "Displays", href: "/displays", icon: "monitor" },
    { label: "Map", href: "/map", icon: "map" },
    ...featureItems(ctx, user),
    { separator: true, label: "" },
    // The "+" menu shows on every width; these repeat it for the user menu.
    ...newIssueItem(ctx),
    { label: "New app", href: "/apps/new", icon: "rocket" },
    { label: "New repository", href: "/new", icon: "repo" },
    { label: "Migrate", href: "/migrate", icon: "download" },
    ...forgeDoor(ctx),
    { separator: true, label: "" },
    { label: "Settings", href: "/settings", icon: "settings" },
    { label: "Access tokens", href: "/settings/tokens", icon: "key" },
    { label: "SSH keys", href: "/settings/keys", icon: "lock" },
    { label: "Origins", href: "/settings/origins", icon: "globe" },
    ...(!user.isAdmin && administersAny(ctx.app.db, user)
      ? [{ label: "Boards", href: "/boards", icon: "activity" as const }]
      : []),
    ...(user.isAdmin
      ? [
          { label: "Crew", href: "/settings/crew", icon: "bot" as const },
          ...(user.kind === "agent"
            ? []
            : [
                { label: "Boards", href: "/boards", icon: "activity" as const },
                { label: "System memory", href: "/system", icon: "activity" as const },
              ]),
        ]
      : []),
    { separator: true, label: "" },
    helpItem,
    themeForm(theme),
    { separator: true, label: "" },
    signOut,
  ];
  return menu({
    trigger: html`${icon("user")}<span class="hide-sm">${user.username}</span>`,
    items,
    title: `Signed in as ${user.username}`,
  });
}

function searchBar(): Html {
  return html`<form
      class="topbar-search hide-sm"
      method="get"
      action="/search"
      role="search"
    >
      ${icon("search")}
      <input
        type="search"
        name="q"
        aria-label="Search this forge"
        placeholder="Search"
        autocomplete="off"
        data-search-input
      />
      ${kbd(["/"])}
    </form>
    <a class="btn btn-icon hide-lg" href="/search" aria-label="Search"
      >${icon("search")}</a
    >`;
}

// ---- palette index ----

/** The palette's own verbs: where to go, what to make, what to set. */
const STATIC_PALETTE: PaletteItem[] = [
  { t: "Home", h: "/", c: "Go to" },
  { t: "Apps", h: "/apps", c: "Go to" },
  { t: "Explore", h: "/explore", c: "Go to" },
  { t: "Forge packs", h: "/packs", c: "Go to" },
  { t: "Displays", h: "/displays", c: "Go to" },
  { t: "Map", h: "/map", c: "Go to" },
  { t: "What you asked for", h: "/asked", c: "Go to" },
  { t: "Front page", h: "/front", c: "Go to" },
  { t: "New app", h: "/apps/new", c: "Create" },
  { t: "New repository", h: "/new", c: "Create" },
  { t: "Migrate a repository", h: "/migrate", c: "Create" },
  { t: "New organization", h: "/organizations/new", c: "Create" },
  { t: "Notes", h: "/notes", c: "Go to" },
  { t: "Talk to the forge", h: "/talk", c: "Go to" },
  { t: "Search", h: "/search", c: "Go to" },
  { t: "Account settings", h: "/settings", c: "Settings" },
  { t: "Access tokens", h: "/settings/tokens", c: "Settings" },
  { t: "SSH keys", h: "/settings/keys", c: "Settings" },
  { t: "Origins", h: "/settings/origins", c: "Settings" },
  { t: "Your shells", h: "/settings/shells", c: "Settings" },
];

/** What a signed-out visitor can reach: places to go, not Create and Settings rows that end at a sign-in wall. */
const VISITOR_PALETTE = new Set(["Home", "Apps", "Explore", "Forge packs", "Front page", "Search"]);

/** First path segments that are the forge's own pages, never an owner: no repository read for them. */
const NOT_AN_OWNER = new Set([
  ...STATIC_PALETTE.map((p) => p.h.split("/")[1] ?? ""),
  "api", "releases", "audit", "admin", "tell", "login", "logout", "signup", "feed", "boards", "organizations", "static", "assets",
]);

/**
 * Where the palette's "Tell the crew" row sends a sentence, as the feed
 * composer's `app` field names it: the repository the page is on when the
 * viewer may direct its crew, else the forge itself, which costs no
 * repository read. Absent for anyone who may not tell (signed out, or an
 * organization), and then the row is not drawn.
 */
function tellTarget(ctx: Ctx): { app: string } | undefined {
  const user = ctx.auth.user;
  if (user === undefined || user.kind === "org") return undefined;
  const [owner, name] = ctx.url.pathname.split("/").filter((s) => s !== "");
  const here =
    owner !== undefined && name !== undefined && !NOT_AN_OWNER.has(owner)
      ? getRepo(ctx.app.db, owner, name)
      : undefined;
  if (here !== undefined && mayDirectCrew(ctx.app.db, here, user))
    return { app: `${here.ownerName}/${here.name}` };
  return { app: "forge" };
}

/**
 * The palette index rides as a `<script type="application/json">` data block.
 * The HTML spec stops parsing such a block as script, so the CSP never
 * applies and no nonce is needed — but `</script` must not appear inside it,
 * which escaping `<` guarantees.
 *
 * The by-name rows are every repository the viewer can see, apps among them.
 */
function paletteIndex(ctx: Ctx, extra: PaletteItem[]): Html {
  // One forge (#603): a conversation's remote row is built with the
  // studio's nouns, which answer for every repository.
  const studio = true;
  // The viewer's own first, apps ahead of the rest in each half, thirty in
  // all; archived ones
  // are put away, found by typing the full name into search.
  const wanted = { limit: 30, appsFirst: true, withoutArchived: true };
  const mine = ctx.auth.user
    ? listReposByOwner(ctx.app.db, ctx.auth.user.username, ctx.auth.user, wanted)
    : [];
  const taken = new Set(mine.map((r) => r.id));
  const repos = [
    ...mine,
    ...listReposVisibleTo(ctx.app.db, ctx.auth.user, wanted).filter(
      (r) => !taken.has(r.id),
    ),
  ].slice(0, 30);
  const apps = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  // A private app is the writers' to see; to anyone else the row is plain.
  // Asked once for the page, never per row.
  const enterable = enterableApps(
    ctx.app.db,
    repos.flatMap((repo) => {
      const app = apps.get(repo.id);
      return app === undefined ? [] : [{ repo, app }];
    }),
    ctx.auth.user,
    { named: false },
  );
  const open = repos.flatMap((r) => {
    const app = apps.get(r.id);
    return app !== undefined && enterable.has(app.id) ? [app] : [];
  });
  const states = open.length > 0 ? appsRuntime(ctx.app)?.statusMany(open) : undefined;
  const foundry = foundryHref(ctx.app, ctx.auth.user);
  const items: PaletteItem[] = [
    ...extra,
    ...repos.map((r): PaletteItem => {
      const found = apps.get(r.id);
      const app = found !== undefined && enterable.has(found.id) ? found : undefined;
      const base = `/${r.ownerName}/${r.name}`;
      const state =
        app === undefined
          ? undefined
          : states?.get(app.id)?.find((e) => e.env === "production")?.state;
      return {
        t: `${r.ownerName}/${r.name}`,
        h: base,
        c: "Repositories",
        n: r.name,
        ...(r.ownerId === ctx.auth.user?.id ? { m: 1 as const } : {}),
        ...(app === undefined
          ? {}
          : {
              x: `App · ${state ?? "not running"}`,
              o: `${base}/app/production/open`,
            }),
      };
    }),
    ...(ctx.auth.user
      ? STATIC_PALETTE
      : [
          ...STATIC_PALETTE.filter((p) => VISITOR_PALETTE.has(p.t)),
          {
            t: "Sign in",
            h: signInHref(ctx),
            c: "Go to",
          },
        ]),
    ...(sendsForges(ctx)
      ? [{ t: "New forge", h: "/forges/new", c: "Create" }]
      : []),
    ...(foundry === undefined ? [] : [{ t: "Foundry", h: foundry, c: "Go to" }]),
    ...(ctx.auth.user?.isAdmin
      ? [
          { t: "System", h: "/system", c: "Go to" },
          { t: "Forges you sent", h: "/forges", c: "Go to" },
          { t: "Family of forges", h: "/family", c: "Go to" },
        ]
      : []),
  ];
  // `studio` rides along so the palette's *remote* rows — what the search
  // API found, folded in the browser — build the same addresses the server
  // just rendered (`tellHref`/`changeHref`, `src/web/studio/nouns.ts`). The
  // palette can never hand out a noun the page behind it would not.
  const json = JSON.stringify({
    items,
    studio,
    me: ctx.auth.user?.username,
    tell: tellTarget(ctx),
  }).replaceAll("<", "\\u003c");
  return raw(
    `<script type="application/json" id="palette-index">${json}</script>`,
  );
}

/**
 * The palette is a combobox over a listbox inside a modal dialog: the input
 * owns the focus and points at the highlighted row (`aria-activedescendant`,
 * set by the script), the rows are options under group headings. Plain
 * `type="text"`: a search field's own Escape (clear the box) would eat the
 * one that should close the dialog.
 */
function overlays(): Html {
  return html`<dialog
      class="dialog palette"
      id="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <input
        class="input palette-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-controls="palette-list"
        aria-autocomplete="list"
        placeholder="Jump to a repository, page or action…"
        aria-label="Command palette"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
      <div
        class="palette-list"
        id="palette-list"
        role="listbox"
        aria-label="Results"
      ></div>
      <div class="palette-foot">
        ${kbd(["↑", "↓"])} navigate ${kbd(["↵"])} open ${kbd(["⌘", "↵"])} its app ${kbd(["esc"])} close
      </div>
    </dialog>
    <dialog class="dialog" id="help-dialog" aria-labelledby="help-title">
      <div class="dialog-head"><h2 id="help-title">Keyboard shortcuts</h2></div>
      <div class="dialog-body" data-help-body></div>
      <div class="dialog-foot">
        <form method="dialog">
          <button class="btn" type="submit">Close</button>
        </form>
      </div>
    </dialog>`;
}

function flashToast(flash: Flash): Html {
  const tone = flash.tone ?? "success";
  const glyph =
    tone === "danger" ? "alert" : tone === "attn" ? "alert" : "check";
  return html`<div class="toast" data-tone="${tone}" role="status">
    ${icon(glyph)}
    <div class="toast-body">
      ${flash.message}${when(
        flash.link,
        (link) => html` · <a href="${link.href}">${link.label}</a>`,
      )}
      ${when(
        flash.code,
        (code) =>
          copyField("flash-code", code, "Code", "Copy code"),
      )}
    </div>
  </div>`;
}

// ---- the chrome ----

/** Where a signed-out visitor's way in leads: the topbar button and the palette's Sign in share it. */
export function signInHref(ctx: Ctx): string {
  const token = activeEdgeToken(ctx.app);
  if (edgeStrangerLogin(ctx.request, token, ctx.auth.user) !== undefined) return "/signup";
  return token === undefined ? "/signin" : edgeLoginUrl(ctx.url.pathname + ctx.url.search);
}

/** The skip link and the topbar: the wordmark, the crumbs, the tools. */
function topbar(
  ctx: Ctx,
  theme: ThemeName | undefined,
  crumbs: PageOptions["crumbs"],
  tools?: Html,
  about?: string,
): Html {
  const user = ctx.auth.user;
  return html`<a class="skip" href="#main">Skip to content</a>
    <header class="topbar" role="banner">
      <a href="/" class="wordmark" data-shortcut="g h" ${hintAttr("g h")}
        ><span class="mark"></span>forge</a
      >
      ${when(
        crumbs,
        (items) =>
          html`<nav class="crumbs" aria-label="Location">
            ${items.map(
              (crumb, i) =>
                html`${i > 0 ? html`<span class="sep">/</span>` : null}<a
                    href="${crumb.href}"
                    >${crumb.label}</a
                  >`,
            )}
          </nav>`,
      )}
      <span class="spacer"></span>
      <span class="topbar-tools">
        ${tools ?? html`${searchBar()}
        ${user
          ? html`<a class="btn btn-icon" href="${talkHref(about)}" aria-label="Talk to the forge" data-shortcut="g t" ${hintAttr("g t", "Talk to the forge")}
                >${icon("comment")}</a
              ><a class="small" href="/asks" data-shortcut="g q" ${hintAttr("g q")}>Asks</a
              >${newMenu(ctx)}${userMenu(
                ctx,
                user,
                theme,
                ctx.auth.via === "edge"
                  ? {
                      label: "Sign out",
                      href: edgeLogoutUrl("/"),
                      icon: "signOut",
                    }
                  : { label: "Sign out", post: "/logout", icon: "signOut" },
                about,
              )}`
          : html`${guestMenu(ctx, theme)}${btn("Sign in", {
              href: signInHref(ctx),
            })}`}`}
      </span>
    </header>`;
}

/**
 * The foot of every page. A site admin reads what is running there, as the
 * build stamped it (`kernel/version.ts`), in place of the line everyone
 * else gets: the one person who is asked "which version is this?".
 */
function footer(ctx: Ctx, own?: Html): Html {
  if (own !== undefined) return html`<footer class="foot">${own}</footer>`;
  const reduced =
    ctx.auth.user?.isAdmin === true ? protectionNotice() : undefined;
  return html`<footer class="foot">
    <span class="mark"></span>
    <span
      >forge
      ${ctx.auth.user?.isAdmin === true
        ? runningLine()
        : "· yours to keep"}</span
    >
    ${reduced === undefined
      ? null
      : html`<span class="reduced" id="reduced-protection"
          >${reduced}</span
        >`}
    <span class="spacer"></span>
    <a href="/changelog">Changelog</a>
    <a href="/api">API</a>
    ${ctx.auth.user !== undefined && ctx.auth.user.kind !== "org"
      ? html`<a class="btn" data-variant="link" data-size="sm" href="/#composer">Tell the crew</a>`
      : ""}
    <button
      class="btn js-only"
      data-variant="link"
      data-size="sm"
      type="button"
      data-palette
    >
      Command palette
    </button>
  </footer>`;
}

// ---- the page ----


function pageDescription(options: PageOptions): string {
  const own = options.description?.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const line = own === "" ? SITE_LINE : own;
  return line.length <= 200 ? line : `${line.slice(0, 197).trimEnd()}…`;
}

/**
 * The tab title: the forge named once, whether or not the page's own title
 * already ends in it, or opens with it ("forge: …" names it already).
 */
export function tabTitle(title: string): string {
  const own = title.replace(/(?: · forge)+$/, "");
  if (own === "" || own === "forge") return "forge";
  return own.startsWith("forge: ") ? own : `${own} · forge`;
}

export function page(options: PageOptions, status = 200): Response {
  // No nonce: a script is a hashed file the policy admits as 'self', and an
  // inline <style> is admitted by the hash of its own text, so the same page
  // is the same bytes for everyone and can be cached (docs/web.md).
  const { ctx } = options;
  const theme = ctx.theme ?? options.theme;
  const cookieFlash = readFlash(ctx.request);
  const flash = options.flash ?? cookieFlash;
  const links = pageLinks(ctx);

  // The body's markup. Every `icon()` left a `<use>` behind; they are aimed
  // at the one hashed sprite file below, so no page carries a drawing.
  const shell = html`${options.bare ? null : topbar(ctx, theme, options.crumbs, options.tools, options.about)}
    <main
      class="${options.bare
        ? "bare"
        : options.wide
          ? "shell shell-wide"
          : "shell"}"
      id="main"
    >
      ${flash ? flashToast(flash) : null}${options.body}
    </main>
    ${options.bare ? null : footer(ctx, options.foot)} ${overlays()}
    ${paletteIndex(ctx, options.palette ?? [])}`;

  const own = options.scriptJs ? pageScriptAsset(options.scriptJs, ctx.app.config.dataDir) : undefined;

  const doc = html`<!doctype html>
    <html lang="en" ${theme ? html`data-theme="${theme}"` : null}>
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>${tabTitle(options.title)}</title>
        <meta name="description" content="${pageDescription(options)}" />
        <meta property="og:site_name" content="forge" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="${options.title}" />
        <meta property="og:description" content="${pageDescription(options)}" />
        ${
          // Only a page that exists has a canonical address. An error page
          // never echoes the path that was asked for: two dead links must be
          // the same bytes, or the difference tells a guesser something.
          status === 200
            ? html`<meta
                  property="og:url"
                  content="${ctx.url.origin}${ctx.url.pathname}"
                />
                <link
                  rel="canonical"
                  href="${ctx.url.origin}${ctx.url.pathname}"
                />`
            : null
        }
        <meta
          property="og:image"
          content="${ctx.url.origin}${
            options.ogImage !== undefined && options.ogImage.startsWith("/og/")
              ? options.ogImage
              : "/og/site.png"
          }"
        />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link
          rel="search"
          type="${OPENSEARCH_TYPE}"
          href="${OPENSEARCH_PATH}"
          title="${OPENSEARCH_TITLE}"
        />
        ${links.map(
          (l) =>
            html`<link
              rel="${l.rel}"
              href="${l.href}"
              ${l.title === undefined ? null : html`title="${l.title}"`}
              ${l.type === undefined ? null : html`type="${l.type}"`}
            />`,
        )}
        <link rel="apple-touch-icon" href="/icons/forge-180.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="forge" />
        ${when(
          options.feed,
          (f) =>
            html`<link
              rel="alternate"
              type="application/atom+xml"
              title="${f.title}"
              href="${f.href}"
            />`,
        )}
        ${when(
          options.json,
          (j) => html`<link rel="alternate" type="application/json" title="${j.title}" href="${j.href}" />`,
        )}
        ${when(options.jsonLd, (d) => html`<script type="application/ld+json">${raw(d)}</script>`)}
        <meta name="color-scheme" content="light dark" />
        ${theme
          ? html`<meta name="theme-color" content="${metaThemeColor(theme)}" />`
          : html`<meta
                name="theme-color"
                media="(prefers-color-scheme: light)"
                content="${metaThemeColor("light")}"
              />
              <meta
                name="theme-color"
                media="(prefers-color-scheme: dark)"
                content="${metaThemeColor("dark")}"
              />`}
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%232563eb'/%3E%3Cstop offset='1' stop-color='%237c3aed'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='3' y='3' width='26' height='26' rx='8' fill='url(%23g)'/%3E%3C/svg%3E"
        />
        ${raw(`<style>${bootCss}</style>`)}
        <link rel="stylesheet" href="${stylesheetAsset().path}" />
        ${when(
          options.turnstile,
          () =>
            html`<script
              src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js"
              async
              defer
            ></script>`,
        )}
        ${when(
          options.scriptAsset,
          (src) => html`<script type="module" src="${src}"></script>`,
        )}
        ${options.styleCss
          ? raw(`<style>${options.styleCss}</style>`)
          : null}
      </head>
      <body>
        ${shell}
        <script src="${shellAsset().path}" defer></script>
        <script src="${beaconAsset().path}" defer></script>
        ${own ? html`<script src="${own.path}" defer></script>` : null}
      </body>
    </html>`;

  // Signed-out, flash-free pages are tagged by their own bytes so a revisit
  // costs a 304 (`http/etag.ts`).
  const tagged = taggable(ctx.request, ctx.auth.user !== undefined, flash !== undefined) && status === 200;
  const text = pointAtSprite(doc.text, spriteAsset().path);
  const styleSources = [bootCss, ...(options.styleCss ? [options.styleCss] : [])]
    .map((css) => `'sha256-${new Bun.CryptoHasher("sha256").update(css).digest("base64")}'`)
    .join(" ");
  const cacheControl = tagged
    ? sharedCache(ctx.request, ctx.url.pathname, (o, n) => getRepo(ctx.app.db, o, n)?.visibility === "public")
    : "no-cache";
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // The hashed stylesheet and scripts are 'self'; the two inline <style>s
    // are named by hash. connect-src 'self' lets the live event stream
    // (EventSource) and fragment fetches reach same-origin.
    "content-security-policy": `default-src 'none'; style-src 'self' ${styleSources}; script-src 'self'${options.wasm ? " 'wasm-unsafe-eval'" : ""}${options.turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}; connect-src 'self'${options.turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}; ${frameSources(options)}worker-src 'self'; manifest-src 'self'; img-src 'self' data:; ${options.objectSrc ? "object-src 'self'; " : ""}${options.fontSrc ? "font-src 'self'; " : ""}form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    // Markup is revalidated every time; only the hashed assets it names are
    // cached, so no cache can pair new HTML with an old stylesheet. A
    // signed-out public page may also sit at the edge for a minute
    // (`sharedCache`); a signed-in one never does.
    "cache-control": cacheControl,
    // The assets the head names, as preloads: an edge turns them into 103
    // Early Hints, so the browser fetches them before the body arrives.
    link: [
      linkHeader(links),
      `<${stylesheetAsset().path}>; rel=preload; as=style`,
      `<${shellAsset().path}>; rel=preload; as=script`,
      ...(own ? [`<${own.path}>; rel=preload; as=script`] : []),
    ]
      .filter((l) => l !== "")
      .join(", "),
    "speculation-rules": `"${speculationAsset().path}"`,
  });
  // A flash is shown exactly once: rendering it is also what clears it.
  if (cookieFlash) headers.append("set-cookie", clearFlashCookie(ctx.url, ctx.app.config.url));
  // A shared copy is keyed on identity, so a request that carries any is a
  // miss at the edge and never sees the anonymous page (docs/web.md).
  if (cacheControl.startsWith("public")) headers.set("vary", EDGE_VARY);
  if (tagged) {
    const etag = weakEtag(text);
    headers.set("etag", etag);
    if (holds(ctx.request, etag))
      return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status, headers });
}

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** A bare origin: scheme, host and optional port, nothing that could add a directive. */
const BARE_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

/** The `frame-src` directive (with its trailing space), or nothing when the page frames nothing. */
export function frameSources(options: Pick<PageOptions, "turnstile" | "frameSrc">): string {
  const origins = [
    ...(options.turnstile ? [TURNSTILE_ORIGIN] : []),
    ...(options.frameSrc !== undefined && BARE_ORIGIN.test(options.frameSrc) ? [options.frameSrc] : []),
  ];
  return origins.length === 0 ? "" : `frame-src ${origins.join(" ")}; `;
}

export interface RedirectOptions {
  /** A Set-Cookie value to send alongside (session, theme). */
  cookie?: string;
  /** A message to show on the page we are redirecting to. */
  flash?: Flash;
  /** Needed only so the flash cookie learns whether to be Secure. */
  url?: URL;
  /** The forge's own address: https there makes the cookie Secure behind a TLS-ending proxy. */
  forgeUrl?: string | undefined;
}

export function redirect(
  to: string,
  options: RedirectOptions | string = {},
): Response {
  const o: RedirectOptions =
    typeof options === "string" ? { cookie: options } : options;
  const headers = new Headers({ location: to });
  if (o.cookie !== undefined) headers.append("set-cookie", o.cookie);
  if (o.flash !== undefined)
    headers.append("set-cookie", flashCookie(o.flash, o.url, o.forgeUrl));
  return new Response(null, { status: 303, headers });
}

/**
 * A slice of a page, for a script that is replacing one region of it. The
 * sandbox CSP is the point: this markup is inserted into a live document, so
 * it is served with a policy that would make it inert if anything ever
 * navigated to it directly.
 *
 * Its icons are inlined rather than referenced: a fragment cannot count on
 * the sprite of the document it is being dropped into, and must not add ids
 * to it (`inlineIcons`, `icons.ts`).
 *
 * A fragment names its own bytes: the `etag` is a hash of the body, and a
 * request carrying it back as `if-none-match` gets a 304 and nothing to
 * paint. `cache-control: no-store` keeps the browser's own cache out of it —
 * the live client holds the tag itself and asks conditionally on purpose,
 * so an unchanged region costs one round trip and no repaint.
 *
 * The same tag is stamped on the fragment's first element as `data-etag`,
 * because a proxy in between may drop the header: Cloudflare strips `etag`
 * from HTML it reserves the right to rewrite, and did on the live forge.
 * The hash is of the unstamped body, so the server recomputes it the same
 * way next time; the request header is what it compares.
 */
export function fragment(
  body: Html,
  o: { status?: number; request?: Request } = {},
): Response {
  const text = inlineIcons(body.text);
  const status = o.status ?? 200;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'none'; sandbox",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
  if (status !== 200) return new Response(text, { status, headers });
  const hash = sha256(text).slice(0, 16);
  headers.etag = `"${hash}"`;
  if (o.request?.headers.get("if-none-match") === headers.etag)
    return new Response(null, { status: 304, headers });
  return new Response(
    text.replace(/^(\s*<[a-zA-Z][^\s>]*)/, `$1 data-etag="${hash}"`),
    { status, headers },
  );
}

/** The empty 404 fragment, its build named `render` so the request's phases still add up. */
export function missingFragment(request: Request): Response {
  const started = performance.now();
  const response = fragment(html``, { status: 404 });
  notePhase(request, "render", performance.now() - started);
  return response;
}

/** Redirect back to a page carrying a message — the shape most handlers want. */
export function flashTo(ctx: Ctx, to: string, flash: Flash): Response {
  return redirect(to, { flash, url: ctx.url, forgeUrl: ctx.app.config.url });
}

/**
 * A form's answer with two faces: the redirect and flash a plain form gets,
 * or — when the client asked for JSON, to act in place — `{ ok: true,
 * flash }` or `{ ok: false, error }` (422), with anything `extra` beside it.
 * One route, one outcome; only the way it is told differs.
 */
export function flashOrJson(
  ctx: Ctx,
  to: string,
  flash: Flash,
  extra: Record<string, unknown> = {},
): Response {
  if (!prefersJson(ctx)) return flashTo(ctx, to, flash);
  return flash.tone === "danger"
    ? json({ ok: false, error: flash.message, ...extra }, 422)
    : json({ ok: true, flash: flash.message, ...extra });
}
