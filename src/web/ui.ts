/**
 * The component vocabulary as functions. Every visual pattern the forge uses
 * lives here exactly once, so a page describes *what* it shows and never
 * *how* it looks. `docs/DESIGN.md` is the contract these implement — the same
 * names, variants, and states a terminal UI can mirror.
 *
 * Rules: anything that navigates is an `<a>`, anything that mutates is a
 * `<button>` inside a `<form method=post>`; icon-only controls carry an
 * `aria-label`; numbers that align carry tabular numerals; nothing here
 * reaches for an inline `style` attribute, because the CSP forbids it.
 */

import { icon, type IconName } from "./icons.ts";
import { Html, html, raw, when } from "./html.ts";

export { icon, type IconName };

export type Tone = "default" | "success" | "danger" | "merged" | "attn";

// ---- text and time ----

/** A compact relative time: the only clock the UI speaks in. */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * A timestamp a machine and a screen reader can both read: relative text for
 * the eye, the exact instant in `datetime` and `title` for everyone else.
 */
export function time(iso: string): Html {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return html``;
  const at = new Date(parsed);
  const exact = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return html`<time datetime="${at.toISOString()}" title="${exact}"
    >${timeAgo(iso)}</time
  >`;
}

/** Bytes, three significant figures, never more precision than is true. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- buttons ----

export interface BtnOptions {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger" | "link";
  size?: "sm" | "lg";
  /** Renders an `<a>`; without it you get a `<button>`. */
  href?: string;
  type?: "submit" | "button";
  name?: string;
  value?: string;
  title?: string;
  label?: string;
  icon?: IconName;
  /** Submit a form this button does not sit inside — the way to offer two
   * actions in one row without nesting forms, which HTML forbids. */
  form?: string;
  /** A `g i`-style keyboard sequence the shell's shortcut layer picks up. */
  shortcut?: string;
  /** Copy the text of the element with this id (enhancement; inert with JS off). */
  copy?: string;
  disabled?: boolean;
  current?: boolean;
  extra?: string;
}

function btnAttrs(o: BtnOptions): Html {
  return html`class="btn${o.extra ? ` ${o.extra}` : ""}"
  ${o.variant ? html`data-variant="${o.variant}"` : null}
  ${o.size ? html`data-size="${o.size}"` : null}
  ${o.title ? html`title="${o.title}"` : null}
  ${o.label ? html`aria-label="${o.label}"` : null}
  ${o.shortcut ? html`data-shortcut="${o.shortcut}"` : null}
  ${o.copy ? html`data-copy="${o.copy}"` : null}
  ${o.current ? raw('aria-current="page"') : null}`;
}

/** A button or a link that looks like one. Content is the visible label. */
export function btn(content: Html | string, o: BtnOptions = {}): Html {
  const inner = html`${o.icon ? icon(o.icon) : null}${content}`;
  if (o.href !== undefined) {
    return html`<a href="${o.href}" ${btnAttrs(o)}>${inner}</a>`;
  }
  return html`<button
    type="${o.type ?? "submit"}"
    ${o.name ? html`name="${o.name}"` : null}
    ${o.value !== undefined ? html`value="${o.value}"` : null}
    ${o.form ? html`form="${o.form}"` : null}
    ${o.disabled ? raw("disabled") : null}
    ${btnAttrs(o)}
  >
    ${inner}
  </button>`;
}

/** Icon-only: the label is required, and becomes both tooltip and a11y name. */
export function iconBtn(
  name: IconName,
  label: string,
  o: BtnOptions = {},
): Html {
  const opts: BtnOptions = {
    ...o,
    label,
    title: o.title ?? label,
    extra: `btn-icon${o.extra ? ` ${o.extra}` : ""}`,
  };
  return btn(icon(name), opts);
}

// ---- badges, labels, pills, dots ----

export function badge(
  text: Html | string,
  o: { tone?: Tone; icon?: IconName; variant?: "secondary" | "outline" } = {},
): Html {
  const variant =
    o.tone && o.tone !== "default" ? o.tone : (o.variant ?? undefined);
  return html`<span
    class="badge"
    ${variant ? html`data-variant="${variant}"` : null}
    >${o.icon ? icon(o.icon) : null}${text}</span
  >`;
}

/** The one badge whose value is a state machine, so it renders identically
 * on issues, pulls and lists. */
export function stateBadge(state: "open" | "closed" | "merged"): Html {
  if (state === "merged")
    return html`<span class="badge" data-pr="merged"
      >${icon("merge")}Merged</span
    >`;
  if (state === "closed")
    return html`<span class="badge" data-state="closed"
      >${icon("issueClosed")}Closed</span
    >`;
  return html`<span class="badge" data-state="open"
    >${icon("issue")}Open</span
  >`;
}

export interface LabelLike {
  readonly name: string;
  readonly color: string;
}

/** A label chip. Its color arrives as a custom property from `labelCss`. */
export function labelChip(label: LabelLike, href?: string): Html {
  const cls = `label lc-${label.color}`;
  return href === undefined
    ? html`<span class="${cls}">${label.name}</span>`
    : html`<a class="${cls}" href="${href}">${label.name}</a>`;
}

/**
 * The CSS binding label colors to their chips, for the page's nonce'd
 * <style>. This is a CSS-injection boundary: the hex is re-validated here,
 * immediately before it is embedded, and anything else is dropped. Colors are
 * deduplicated, so a page of 200 issues emits a handful of rules.
 */
export function labelCss(labels: Iterable<LabelLike | string>): string {
  let css = "";
  const seen = new Set<string>();
  for (const entry of labels) {
    const color = typeof entry === "string" ? entry : entry.color;
    if (seen.has(color) || !/^[0-9a-f]{6}$/.test(color)) continue;
    seen.add(color);
    css += `.lc-${color}{--label:#${color}}`;
  }
  return css;
}

export function pill(value: number | string, tone?: "accent" | "danger"): Html {
  return html`<span class="pill" ${tone ? html`data-tone="${tone}"` : null}
    >${value}</span
  >`;
}

export function dot(tone: Tone = "default"): Html {
  return html`<span
    class="dot"
    ${tone !== "default" ? html`data-tone="${tone}"` : null}
  ></span>`;
}

/** A short object id in a monospace chip — always the first 7 characters. */
export function sha(oid: string, href?: string): Html {
  const short = oid.slice(0, 7);
  return href === undefined
    ? html`<span class="sha">${short}</span>`
    : html`<a class="sha" href="${href}" title="${oid}">${short}</a>`;
}

export function kbd(keys: string[]): Html {
  return html`${keys.map((k) => html`<kbd>${k}</kbd>`)}`;
}

// ---- identity ----

/** Twelve stable buckets, so the same name always wears the same hue. */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 12;
}

function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1];
  return ((first[0] ?? "?") + (second?.[0] ?? "")).slice(0, 2);
}

export function avatar(name: string, size?: "md" | "lg"): Html {
  return html`<span
    class="avatar"
    data-h="${hueOf(name)}"
    ${size ? html`data-size="${size}"` : null}
    aria-hidden="true"
    >${initials(name)}</span
  >`;
}

/**
 * An author *inside* something that is already a link — a list row, a diff
 * gutter. HTML forbids nesting `<a>` in `<a>`, and a browser does not merely
 * ignore it: the parser closes the outer anchor and re-parents everything
 * after it as a sibling, which silently tears the row apart. So a linked row
 * gets the name as text, and the row's own href carries the navigation.
 */
export function userTag(username: string, o: { avatar?: boolean } = {}): Html {
  return html`<span class="byline"
    >${o.avatar === false ? null : avatar(username)}<span class="byline-name"
      >${username}</span
    ></span
  >`;
}

/**
 * An author who is not an account here: the login they use on the origin,
 * wearing that forge's mark. Deliberately not a link to `/name` — a local
 * profile of that name would be a different person, and saying otherwise is
 * the one lie an imported comment could tell.
 */
export function originTag(login: string, kind: IconName): Html {
  return html`<span class="byline origin-by" title="${login} on the origin"
    >${icon(kind)}<span class="byline-name">${login}</span></span
  >`;
}

/** An author: avatar plus a link to their profile. Never bare text. */
export function userLink(
  username: string,
  o: { avatar?: boolean; display?: string } = {},
): Html {
  return html`<span class="byline"
    >${o.avatar === false ? null : avatar(username)}<a href="/${username}"
      >${o.display || username}</a
    ></span
  >`;
}

// ---- surfaces ----

export interface CardOptions {
  tone?: Tone;
  head?: Html;
  foot?: Html;
  /** Wrap the body in `.card-body` padding. Lists and tables opt out. */
  pad?: boolean;
  id?: string;
  extra?: string;
}

export function card(body: Html, o: CardOptions = {}): Html {
  return html`<div
    class="card${o.extra ? ` ${o.extra}` : ""}"
    ${o.id ? html`id="${o.id}"` : null}
    ${o.tone && o.tone !== "default" ? html`data-tone="${o.tone}"` : null}
  >
    ${o.head ? html`<div class="card-head">${o.head}</div>` : null}
    ${o.pad === false ? body : html`<div class="card-body">${body}</div>`}
    ${o.foot ? html`<div class="card-foot">${o.foot}</div>` : null}
  </div>`;
}

/** A card wrapping a `<ul class="list">` — the shape every listing takes. */
export function listCard(rows: Html[], o: CardOptions = {}): Html {
  return card(
    html`<ul class="list">
      ${rows}
    </ul>`,
    { ...o, pad: false },
  );
}

export interface RowOptions {
  href?: string;
  title: Html | string;
  meta?: Html;
  lead?: Html;
  trail?: Html;
  state?: "open" | "closed" | "merged" | "draft";
  /** The row joins `j`/`k` keyboard traversal. */
  nav?: boolean;
  titleAttr?: string;
}

/** One list row. `<a>` when it navigates, `<div>` when it holds its own
 * controls — the hover affordance follows automatically. */
export function row(o: RowOptions): Html {
  const inner = html`${o.lead
      ? html`<span class="row-lead">${o.lead}</span>`
      : null}
    <span class="row-main">
      <span
        class="row-title"
        ${o.titleAttr ? html`title="${o.titleAttr}"` : null}
        >${o.title}</span
      >
      ${o.meta ? html`<span class="row-meta">${o.meta}</span>` : null}
    </span>
    ${o.trail && o.trail.text.trim() !== ""
      ? html`<span class="row-trail">${o.trail}</span>`
      : null}`;
  const attrs = html`class="row"
  ${o.state ? html`data-state="${o.state}"` : null}
  ${o.nav ? raw('data-nav tabindex="-1"') : null}`;
  return html`<li>
    ${o.href !== undefined
      ? html`<a href="${o.href}" ${attrs}>${inner}</a>`
      : html`<div ${attrs}>${inner}</div>`}
  </li>`;
}

// ---- navigation ----

export interface TabItem {
  label: string;
  href: string;
  icon?: IconName;
  count?: number;
  current?: boolean;
  shortcut?: string;
}

/** Link tabs. They are navigation, so they use `aria-current`, never
 * `role="tab"` — honest semantics beat imitated ones. */
export function tabs(items: TabItem[], ariaLabel: string): Html {
  return html`<nav class="tabs" aria-label="${ariaLabel}">
    ${items.map(
      (t) =>
        html`<a
          href="${t.href}"
          ${t.current ? raw('aria-current="page"') : null}
          ${t.shortcut ? html`data-shortcut="${t.shortcut}"` : null}
          >${t.icon ? icon(t.icon) : null}${t.label}${t.count !== undefined &&
          t.count > 0
            ? pill(t.count)
            : null}</a
        >`,
    )}
  </nav>`;
}

/** A segmented control built from links (a GET filter is navigation). */
export function seg(
  items: { label: string; href: string; current: boolean; count?: number }[],
): Html {
  return html`<div class="seg">
    ${items.map(
      (i) =>
        html`<a
          href="${i.href}"
          ${i.current ? raw('aria-current="page"') : null}
          >${i.label}${i.count !== undefined ? pill(i.count) : null}</a
        >`,
    )}
  </div>`;
}

export function crumbs(
  items: { label: string; href?: string }[],
  o: { mono?: boolean; ariaLabel?: string } = {},
): Html {
  return html`<nav
    class="crumbs${o.mono ? " mono" : ""}"
    aria-label="${o.ariaLabel ?? "Breadcrumb"}"
  >
    ${items.map((c, i) => {
      const last = i === items.length - 1;
      const sep = i > 0 ? html`<span class="sep">/</span>` : null;
      return html`${sep}${c.href !== undefined && !last
        ? html`<a href="${c.href}">${c.label}</a>`
        : html`<span ${last ? raw('aria-current="page"') : null}
            >${c.label}</span
          >`}`;
    })}
  </nav>`;
}

/** Cursor pagination: two links and an honest disabled end. */
export function pager(o: {
  prev?: string;
  next?: string;
  note?: Html | string;
}): Html {
  if (!o.prev && !o.next && !o.note) return html``;
  return html`<nav class="pager" aria-label="Pagination">
    ${o.prev
      ? btn("Newer", { href: o.prev, size: "sm", variant: "outline" })
      : null}
    ${o.note ? html`<span>${o.note}</span>` : null}
    ${o.next
      ? btn("Older", { href: o.next, size: "sm", variant: "outline" })
      : null}
  </nav>`;
}

export interface MenuItem {
  label: string;
  href?: string;
  icon?: IconName;
  current?: boolean;
  separator?: boolean;
  /** Renders as a submit button inside its own POST form. */
  post?: string;
}

/** A dropdown built on `<details>` — the only construct correct with JS off. */
export function menu(o: {
  trigger: Html | string;
  items: (MenuItem | Html)[];
  label?: string;
  align?: "start" | "end";
  title?: string;
  triggerOptions?: BtnOptions;
  name?: string;
}): Html {
  const t = o.triggerOptions ?? {};
  return html`<details
    class="menu"
    ${o.align ? html`data-align="${o.align}"` : null}
    ${o.name ? html`name="${o.name}"` : null}
  >
    <summary
      class="btn${t.extra ? ` ${t.extra}` : ""}"
      ${t.variant ? html`data-variant="${t.variant}"` : null}
      ${t.size ? html`data-size="${t.size}"` : null}
      ${o.label ? html`aria-label="${o.label}"` : null}
      ${o.label ? html`title="${o.label}"` : null}
      aria-haspopup="menu"
    >
      ${o.trigger}
    </summary>
    <div class="menu-panel">
      ${o.title ? html`<span class="menu-title">${o.title}</span>` : null}
      ${o.items.map((item) => {
        if (item instanceof Html) return item;
        const i = item;
        if (i.separator) return html`<hr class="menu-sep" />`;
        if (i.post !== undefined) {
          return html`<form method="post" action="${i.post}">
            <button class="menu-item" type="submit">
              ${i.icon ? icon(i.icon) : null}<span class="grow"
                >${i.label}</span
              >
            </button>
          </form>`;
        }
        return html`<a
          class="menu-item"
          href="${i.href ?? "#"}"
          ${i.current ? raw('aria-current="true"') : null}
          >${i.icon ? icon(i.icon) : null}<span class="grow">${i.label}</span
          >${i.current ? icon("check") : null}</a
        >`;
      })}
    </div>
  </details>`;
}

// ---- forms ----

export interface FieldOptions {
  label: string;
  name: string;
  value?: string;
  type?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  autofocus?: boolean;
  autocomplete?: string;
  placeholder?: string;
  pattern?: string;
  minlength?: number;
  rows?: number;
  mono?: boolean;
  id?: string;
}

/** Label, control, hint and error, wired together with `aria-describedby`. */
export function field(o: FieldOptions): Html {
  const id = o.id ?? `f-${o.name}`;
  const described = [o.hint ? `${id}-hint` : "", o.error ? `${id}-err` : ""]
    .filter(Boolean)
    .join(" ");
  const shared = html`class="input${o.mono ? " mono" : ""}" id="${id}"
  name="${o.name}"
  ${described !== "" ? html`aria-describedby="${described}"` : null}
  ${o.error ? raw('aria-invalid="true"') : null}
  ${o.required ? raw("required") : null}
  ${o.autofocus ? raw("autofocus") : null}
  ${o.placeholder ? html`placeholder="${o.placeholder}"` : null}`;
  const control =
    o.type === "textarea"
      ? html`<textarea ${shared} rows="${o.rows ?? 6}" data-grow>
${o.value ?? ""}</textarea
        >`
      : html`<input
          ${shared}
          type="${o.type ?? "text"}"
          value="${o.value ?? ""}"
          ${o.autocomplete ? html`autocomplete="${o.autocomplete}"` : null}
          ${o.pattern ? html`pattern="${o.pattern}"` : null}
          ${o.minlength !== undefined ? html`minlength="${o.minlength}"` : null}
        />`;
  return html`<div class="field" ${o.error ? raw("data-invalid") : null}>
    <label for="${id}">${o.label}</label>
    ${control}
    ${o.hint ? html`<span class="hint" id="${id}-hint">${o.hint}</span>` : null}
    ${o.error
      ? html`<span class="error" id="${id}-err">${o.error}</span>`
      : null}
  </div>`;
}

/** A `<select>` with the same anatomy as `field`. */
export function selectField(
  o: Omit<FieldOptions, "type"> & {
    options: { value: string; label: string; selected?: boolean }[];
  },
): Html {
  const id = o.id ?? `f-${o.name}`;
  return html`<div class="field">
    <label for="${id}">${o.label}</label>
    <select class="input" id="${id}" name="${o.name}">
      ${o.options.map(
        (opt) =>
          html`<option
            value="${opt.value}"
            ${opt.selected ? raw("selected") : null}
          >
            ${opt.label}
          </option>`,
      )}
    </select>
    ${o.hint ? html`<span class="hint">${o.hint}</span>` : null}
  </div>`;
}

/**
 * A destructive action. With JS it opens a `<dialog>`; without it the button
 * is a plain link to a confirm page, so nothing is ever one careless click
 * away and nothing depends on script.
 */
export function confirmAction(o: {
  /** The POST endpoint. The confirm page derives its own wording from it. */
  action: string;
  /** The label on this button only — the confirm page words itself. */
  verb: string;
  size?: "sm" | "lg";
}): Html {
  return btn(o.verb, {
    href: `/-/confirm?to=${encodeURIComponent(o.action)}`,
    variant: "danger",
    ...(o.size ? { size: o.size } : {}),
  });
}

// ---- states ----

export function empty(o: {
  icon?: IconName;
  title: string;
  note?: string;
  action?: Html;
}): Html {
  return html`<div class="card empty">
    ${o.icon ? icon(o.icon, 20) : null}
    <p class="empty-title">${o.title}</p>
    ${o.note ? html`<p>${o.note}</p>` : null} ${o.action ?? null}
  </div>`;
}

export interface TimelineEvent {
  icon: IconName;
  tone?: Tone;
  body: Html;
}

/** A low-emphasis timeline row: icon plus one muted line, never a card. */
export function tlEvent(e: TimelineEvent): Html {
  return html`<div
    class="tl-item"
    data-kind="event"
    ${e.tone && e.tone !== "default" ? html`data-tone="${e.tone}"` : null}
  >
    <span class="tl-dot">${icon(e.icon)}</span>${e.body}
  </div>`;
}

/** A comment-weight timeline row: the card carries the content. */
export function tlComment(body: Html): Html {
  return html`<div class="tl-item" data-kind="comment">
    <span class="tl-dot">${icon("comment")}</span>${body}
  </div>`;
}

export { when };
