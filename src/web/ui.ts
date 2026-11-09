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

import type { EnvState, EnvStatus } from "../apps/runtime.ts";
import type { PreviewData } from "../apps/data.ts";
import type { Mark } from "../core/marks.ts";
import type { RunKind, RunState } from "../core/runs.ts";
import {
  estimateTokens,
  formatTokens,
  textKind,
  tokenNote,
  type TokenBasis,
} from "../kernel/tokens-format.ts";
import { drawChart, type Cell, type Chart } from "../boards/chart.ts";
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
 * `date` words it as the calendar day (`2026-12-02`), for an instant ahead
 * of now, which "ago" cannot name.
 */
export function time(iso: string, opts: { date?: boolean } = {}): Html {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return html``;
  const at = new Date(parsed);
  const exact = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return html`<time datetime="${at.toISOString()}" title="${exact}"
    >${opts.date === true ? at.toISOString().slice(0, 10) : timeAgo(iso)}</time
  >`;
}

/** Seconds to one decimal: `3.4s`. A clock that ran backwards reads `0.0s`. */
function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** The wait a phrase bothers to name: under this it is noise, not news. */
const QUEUED_FLOOR_MS = 1_000;

/**
 * How long a deployment took to start serving, worded for a person:
 * `3.4s after the push` — measured from the instant the push created the
 * deploy run, so however long it waited for a permit is inside the number.
 * When that wait was a second or more it is named too, because the number
 * is otherwise a puzzle: `6.1s after the push · 2.4s queued`.
 *
 * A deploy no push asked for (a redeploy someone pressed, a boot reconcile)
 * has no push to measure from: it is measured from its own start and says
 * so, the same sentence its log makes. Undefined until it serves — never a
 * zero, and never a negative when two clocks disagree.
 */
export function servedPhrase(env: EnvStatus): string | undefined {
  if (env.servingAt === undefined) return undefined;
  const servedAt = Date.parse(env.servingAt);
  const pushedAt = env.createdAt === undefined ? NaN : Date.parse(env.createdAt);
  const startedAt =
    env.deployStartedAt === undefined ? NaN : Date.parse(env.deployStartedAt);
  const pushed = Number.isFinite(pushedAt);
  const from = pushed ? pushedAt : startedAt;
  if (!Number.isFinite(servedAt) || !Number.isFinite(from)) return undefined;
  const phrase = `${seconds(servedAt - from)} ${
    pushed ? "after the push" : "after the deploy started"
  }`;
  if (!pushed || !Number.isFinite(startedAt)) return phrase;
  const queued = startedAt - pushedAt;
  return queued >= QUEUED_FLOOR_MS
    ? `${phrase} · ${seconds(queued)} queued`
    : phrase;
}

/**
 * How long a queued run has waited, worded like the run list's own line
 * (`queued 12m ago`) but compact enough to sit beside a state word: `queued
 * 12m`. `just now` under a minute, so a check that only just queued never
 * reads as `queued 0m`.
 */
export function queuedPhrase(createdAt: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(createdAt)) / 1000);
  if (seconds < 60) return "queued just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `queued ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `queued ${hours}h`;
  return `queued ${Math.floor(hours / 24)}d`;
}

/** Bytes, three significant figures, never more precision than is true. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A token count as a size: `~1.2k tok`, with the tokenizer and whether it is
 * an estimate in the tooltip (`kernel/tokens-format.ts`). Only ever placed
 * beside a byte size, a cost or a percentage — never as a badge of its own.
 */
export function tokenCount(
  n: number,
  basis: TokenBasis,
  kind?: "prose" | "code" | "data",
): Html {
  return html`<span class="num nowrap" title="${tokenNote(n, basis, kind)}"
    >${formatTokens(n, basis)}</span
  >`;
}

/** A file's byte size and, when it is text, its estimated tokens beside it. */
export function sizeWithTokens(bytes: number, path: string): Html {
  const tokens = estimateTokens(bytes, path);
  return tokens === undefined
    ? html`${fileSize(bytes)}`
    : html`${fileSize(bytes)} · ${tokenCount(tokens, "estimated", textKind(path))}`;
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
  /** A link that leaves the forge: new tab, and never a referrer or an
   * opener handle back into this page. */
  external?: boolean;
  disabled?: boolean;
  /** A submit that skips the browser's checks: a structural step (add,
   * remove, go back) must not wait for a field to be filled in. */
  formnovalidate?: boolean;
  /** Where this submit posts instead of its form's own action. */
  formaction?: string;
  current?: boolean;
  /** A toggle: emits `aria-pressed` with its state. */
  pressed?: boolean;
  extra?: string;
  /** The element's id, for a script or a fragment link that finds it. */
  id?: string;
}

function btnAttrs(o: BtnOptions): Html {
  return html`${o.id ? html`id="${o.id}" ` : null}class="btn${o.extra ? ` ${o.extra}` : ""}"
  ${o.variant ? html`data-variant="${o.variant}"` : null}
  ${o.size ? html`data-size="${o.size}"` : null}
  ${o.title ? html`title="${o.title}"` : null}
  ${o.label ? html`aria-label="${o.label}"` : null}
  ${o.shortcut ? html`data-shortcut="${o.shortcut}" ${hintAttr(o.shortcut)}` : null}
  ${o.copy ? html`data-copy="${o.copy}"` : null}
  ${o.pressed !== undefined ? html`aria-pressed="${o.pressed ? "true" : "false"}"` : null}${o.current ? raw('aria-current="page"') : null}`;
}

/** A button or a link that looks like one. Content is the visible label. */
export function btn(content: Html | string, o: BtnOptions = {}): Html {
  const inner = html`${o.icon ? icon(o.icon) : null}${content}`;
  if (o.href !== undefined) {
    return html`<a
      href="${o.href}"
      ${o.external ? raw('target="_blank" rel="noopener noreferrer"') : null}
      ${btnAttrs(o)}
      >${inner}</a
    >`;
  }
  return html`<button
    type="${o.type ?? "submit"}"
    ${o.name ? html`name="${o.name}"` : null}
    ${o.value !== undefined ? html`value="${o.value}"` : null}
    ${o.form ? html`form="${o.form}"` : null}
    ${o.disabled ? raw("disabled") : null}
    ${o.formnovalidate ? raw("formnovalidate") : null}
    ${o.formaction ? html`formaction="${o.formaction}"` : null}
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

/**
 * A string people copy — a clone address, a redirect URI, a command: a
 * read-only `.input` beside a copy button. The value is plain text in the
 * markup, so it selects and copies with no JavaScript; the button is the
 * shortcut. `id` is what the copy script looks up; `label` names the field
 * and `copyLabel` the button, each written out so acronyms keep their case.
 */
export function copyField(
  id: string,
  value: string,
  label: string,
  copyLabel: string,
  o: { lines?: number } = {},
): Html {
  // The button needs script, so it is only on the page when there is script;
  // without it the field is still there to select.
  const button = iconBtn("copy", copyLabel, {
    size: "sm",
    type: "button",
    copy: id,
    extra: "js-only",
  });
  return o.lines !== undefined && o.lines > 1
    ? html`<span class="stack stack-tight"
        ><textarea
          class="input mono"
          id="${id}"
          rows="${o.lines}"
          wrap="off"
          readonly
          aria-label="${label}"
          data-size="sm"
        >${value}</textarea
        >${button}</span
      >`
    : html`<span class="bar"
        ><input
          class="input grow mono"
          id="${id}"
          type="text"
          readonly
          value="${value}"
          aria-label="${label}"
          data-size="sm"
        />${button}</span
      >`;
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

/** A number with a label: one tile of a `.stats` grid. The value is `.num`
 * with its full form in `title`; the note is clamped to two lines, its whole
 * text in `noteTitle`; `spark` is trusted markup (an inline SVG) the caller
 * built, labelled by its own `role="img"` and `aria-label` or by nothing. A
 * link when `href` is set, named by `aria` when given; `tone` marks it. */
export function stat(o: {
  label: string;
  value: string | number | Html;
  title?: string;
  note?: string | Html;
  noteTitle?: string;
  href?: string;
  aria?: string;
  tone?: "attn";
  spark?: Html | null;
}): Html {
  const noteTitle = o.noteTitle === undefined ? null : html` title="${o.noteTitle}"`;
  const body = html`<span class="stat-label">${o.label}</span><span class="stat-value num" title="${o.title ?? String(o.value)}">${o.value}</span>${o.note
    ? html`<span class="stat-note"${noteTitle}>${o.note}</span>`
    : null}${o.spark ? html`<span class="stat-spark">${o.spark}</span>` : null}`;
  const tone = o.tone === undefined ? null : html` data-tone="${o.tone}"`;
  return o.href !== undefined
    ? html`<a class="stat" href="${o.href}"${tone}${o.aria === undefined ? null : html` aria-label="${o.aria}"`}>${body}</a>`
    : html`<div class="stat"${tone}>${body}</div>`;
}

/** The one badge whose value is a state machine, so it renders identically
 * on issues, pulls and lists. */
export function stateBadge(
  state: "open" | "closed" | "merged",
  parked = false,
): Html {
  if (state === "merged")
    return html`<span class="badge" data-pr="merged"
      >${icon("merge")}Merged</span
    >`;
  if (state === "closed")
    return html`<span class="badge" data-state="closed"
      >${icon("issueClosed")}${parked ? "Parked" : "Closed"}</span
    >`;
  return html`<span class="badge" data-state="open"
    >${icon("issue")}Open</span
  >`;
}

/** What a reviewer said about the change as a whole. */
export type Verdict = "approved" | "changes_requested" | "commented";

const VERDICTS: Record<Verdict, { label: string; icon: IconName; tone: Tone }> =
  {
    approved: { label: "Approved", icon: "check", tone: "success" },
    changes_requested: {
      label: "Changes requested",
      icon: "alert",
      tone: "danger",
    },
    commented: { label: "Commented", icon: "comment", tone: "default" },
  };

/**
 * One review verdict, as a badge.
 *
 * A verdict passed on an older head is rendered *muted* rather than hidden:
 * it happened, and who said what is the history the review table exists to
 * keep. What it must not do is look current, because an approval that a push
 * dismissed is exactly the thing a review gate exists to catch.
 */
export function verdictBadge(
  state: Verdict,
  o: { stale?: boolean } = {},
): Html {
  const look = VERDICTS[state];
  if (o.stale)
    return html`<span
      class="badge verdict-stale"
      title="Passed before the latest push, so it no longer counts"
      >${icon(look.icon)}${look.label}</span
    >`;
  return badge(look.label, { icon: look.icon, tone: look.tone });
}

/**
 * A run's state (docs/APPS.md): the one badge a check wears on a pull, a
 * row wears in a list, and a log page wears in its head. A finished deploy
 * "passed" because it is a check; a finished agent run is simply "done".
 */
export function runStateBadge(state: RunState, kind: RunKind = "deploy"): Html {
  switch (state) {
    case "queued":
      return badge("Queued", { icon: "clock", variant: "secondary" });
    case "running":
      return badge("Running", { icon: "loader", tone: "attn" });
    case "ok":
      return badge(kind === "agent" ? "Done" : "Passed", {
        icon: "check",
        tone: "success",
      });
    case "failed":
      return badge("Failed", { icon: "x", tone: "danger" });
    case "cancelled":
      return badge("Cancelled", { icon: "ban", variant: "outline" });
  }
}

/** An environment's state: what production, or a preview, is doing now. */
export function envStateBadge(state: EnvState, dormant = false): Html {
  switch (state) {
    case "stopped":
      if (dormant) return badge("Asleep", { icon: "clock", variant: "outline" });
      return badge("Stopped", { icon: "square", variant: "outline" });
    case "deploying":
      return badge("Deploying", { icon: "loader", tone: "attn" });
    case "running":
      return badge("Running", { icon: "play", tone: "success" });
    case "asleep":
      return badge("Asleep", { icon: "clock", variant: "outline" });
    case "failed":
      return badge("Failed", { icon: "alert", tone: "danger" });
  }
}

/**
 * Why a preview is stopped, when it is only asleep: when, and what it was
 * waiting for. Never a failure's words — nothing broke.
 */
export function dormantNote(env: EnvStatus): Html | null {
  const d = env.dormant;
  if (d === undefined) return null;
  return html`asleep ${time(d.since)} — nobody pushed or commented since
  ${time(d.idleSince)}; its data and pictures are kept`;
}

/** The tone an environment's state gives a `dot()` — a list's one-glance answer. */
export function envTone(state: EnvState | undefined): Tone {
  return state === "running"
    ? "success"
    : state === "deploying"
      ? "attn"
      : state === "failed"
        ? "danger"
        : "default";
}

export { envPhrase } from "../apps/env_phrase.ts";

export interface EnvFactsOptions {
  /** Name the environment's address in full — a card has room for it, a
   * head that already links the app does not. */
  readonly url?: boolean;
}

/**
 * An environment's one line of facts, piece by piece: the commit it runs,
 * how fast it came up (`live 3.4s after the push`, only once it serves),
 * how long it has been up, and a link to the deploy that produced it. Each
 * piece is empty when there is nothing to say. `envFacts` sets them in a
 * card; `envLine` strings them into a list row — the same words either way.
 */
function envLinePieces(base: string, env: EnvStatus): readonly Html[] {
  return [
    when(env.commitOid !== "", () =>
      sha(env.commitOid, `${base}/commit/${env.commitOid}`),
    ),
    when(servedPhrase(env), (phrase) => html`<span>live ${phrase}</span>`),
    when(env.since, (since) => html`<span>up ${time(since)}</span>`),
    when(
      env.runId,
      (id) =>
        html`<a href="${base}/runs/${id}"
            >${env.state === "deploying"
              ? "deploy in progress"
              : env.note !== undefined
                ? "verifying tests"
                : "last deploy"}</a
          >`,
    ),
  ];
}

/**
 * `envFacts`' line as the non-empty pieces alone, for a row's meta to join
 * with its own separator: a row is one line, so it takes the facts without
 * the card's block box around them.
 */
export function envLine(base: string, env: EnvStatus): Html[] {
  return envLinePieces(base, env).filter((p) => p.text !== "");
}

/**
 * What an environment is doing, as facts: the commit it runs, how fast it
 * came up, how long it has been up, a link to the deploy that produced it,
 * and — when the deployment has words of its own — its note and its error.
 * Every page showing an environment renders this one, so `not up` never
 * says less on one page than on another. Facts, not a card: the caller
 * decides what box they sit in.
 */
export function envFacts(
  base: string,
  env: EnvStatus,
  o: EnvFactsOptions = {},
): Html {
  const [commit, served, up, deploy] = envLinePieces(base, env);
  return html`<div class="env-facts">
      ${commit}
      ${served}
      ${up}
      ${deploy}
    </div>
    ${when(
      o.url === true,
      () =>
        html`<p class="env-facts mt">
          <span class="mono truncate" title="${env.url}">${env.url}</span>
        </p>`,
    )}
    ${when(env.note, (note) => html`<p class="muted small">${note}</p>`)}
    ${when(dormantNote(env), (note) => html`<p class="muted small" data-dormant>${note}</p>`)}
    ${when(
      env.busy,
      (busy) =>
        html`<p class="muted small" data-busy>
          ${busy}; kept awake past its idle window
        </p>`,
    )}
    ${when(env.error, (error) => html`<p class="env-error">${error}</p>`)}
    ${when(
      env.failedDeploy,
      // Two `sha`s, never nested inside the run link — a link inside a link
      // tears the paragraph apart, the same reason `userTag` gives a row.
      (fd) => html`<p class="env-error">
        serving ${sha(env.commitOid, `${base}/commit/${env.commitOid}`)} —
        ${sha(fd.commitOid, `${base}/commit/${fd.commitOid}`)} did not come up:
        ${fd.error} (<a href="${base}/runs/${fd.runId}">its deploy</a>)
      </p>`,
    )}`;
}

/**
 * The one fact a preview says about whose data it has: its own copy of
 * production's, taken the moment the change that opened it did — the only
 * moment `ensureEnvData` (`apps/data.ts`) ever takes one, since a redeploy
 * of the same preview keeps what is already there. That instant is a
 * pull's own `createdAt`, already known wherever a preview is drawn, so
 * this never stats the data directory to answer. An app whose preview
 * policy is `empty` has no production data to name, so there is nothing to
 * say — and production's own card never calls this at all: there is
 * nothing to warn about data it simply *is*. Bare text, not a card or a
 * paragraph: the caller decides how it sits beside the rest of the facts.
 */
export function previewDataNote(
  policy: PreviewData,
  openedAt: string,
): Html | null {
  if (policy !== "copy") return null;
  return html`its own copy of production's data, taken ${time(openedAt)}`;
}

/**
 * An environment's terminal, as copyable monospace text with the host key
 * fingerprint beside it — so a first connection can be trusted deliberately
 * — or one line saying the terminal is off, when there is no command to
 * show. Every page that names a way in draws this one, never its own words
 * for "off".
 *
 * "Off" has two causes and a reader deserves to know which: the app
 * declares no `tty` (nothing would answer that connection even if one were
 * open — the sentence stays exactly what it always said), or this forge has
 * no SSH listener (`FORGE_SSH_PORT`, `0` on a forge hosted as an app of
 * another — issue #283) and the app is otherwise willing. The second names
 * the variable that turns it on; neither ever invents a connection string —
 * a command is shown only once there is a listener to reach.
 *
 * The command has a `login@host` in it, which an email-scanning edge on the
 * forge's own domain will otherwise rewrite into a `mailto:` link — turning
 * the one line a reader must copy character for character into a link that
 * hides the login. `<!--email_off-->…<!--/email_off-->` is the marker such
 * scanners honour; it costs nothing where none runs, and the text between
 * the markers is exactly the command, unchanged and still one selectable,
 * copyable line.
 */
export function terminalLine(
  terminal: {
    readonly command?: string;
    readonly reason?: "no_tty" | "no_listener";
  },
  fingerprint?: string | undefined,
): Html {
  if (terminal.command === undefined)
    return terminal.reason === "no_listener"
      ? html`<p class="muted small">
          The terminal is off — this forge has no SSH listener. Set
          <span class="mono">FORGE_SSH_PORT</span> to turn it on.
        </p>`
      : html`<p class="muted small">The terminal is off.</p>`;
  return terminalCommand(terminal.command, fingerprint);
}

/** The command, copyable as one wrapping line, the host key under it and
 * anything `extra` (a link) under that — a §5 `.stack`, no class of its own. */
export function terminalCommand(
  command: string,
  fingerprint?: string | undefined,
  extra?: Html,
): Html {
  return html`<div class="stack stack-tight">
    <code class="mono break"><!--email_off-->${command}<!--/email_off--></code>
    ${when(
      fingerprint,
      (fp) => html`<span class="muted small break">host key ${fp}</span>`,
    )}
    ${extra ?? null}
  </div>`;
}

/**
 * The two things a writer can do to an environment. Both are POST forms —
 * the routes they post to make the same-origin check — and a reader is
 * handed nothing at all.
 */
export function envActions(
  base: string,
  env: EnvStatus,
  writer: boolean,
): Html {
  return when(
    writer,
    () =>
      html`<form method="post" action="${base}/app/${env.env}/redeploy">
          ${btn("Redeploy", { size: "sm", icon: "sync" })}
        </form>
        ${when(
          env.state !== "stopped",
          () =>
            confirmAction({
              action: `${base}/app/${env.env}/stop`,
              verb: "Stop",
              size: "sm",
            }),
        )}`,
  );
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

/**
 * A muted group of icon-and-number facts on a row — open issues, open pulls,
 * comments. Zero is never rendered: a row reading "0 0" is noise, and the
 * absence of the chip carries the same information. Numbers are tabular, so
 * a column of rows lines up.
 *
 * This is the only place a count gets drawn, which is what makes a repository
 * row on the dashboard, a profile, the search results and
 * the origin picker all say the same thing in the same shape.
 */
export function counts(
  items: { icon: IconName; value: number | null | undefined; label: string }[],
): Html {
  const shown = items.filter(
    (i) =>
      typeof i.value === "number" && Number.isFinite(i.value) && i.value > 0,
  );
  if (shown.length === 0) return html``;
  return html`<span class="counts"
    >${shown.map(
      (i) =>
        html`<span class="count num" title="${i.label}"
          >${icon(i.icon)}${i.value}</span
        >`,
    )}</span
  >`;
}

/** The open issue and pull counts every repository row carries. */
export function repoCounts(o: {
  openIssues?: number | null | undefined;
  openPulls?: number | null | undefined;
  /** Some origins report one number for issues *and* pulls; say so. */
  issuesIncludePulls?: boolean;
}): Html {
  const issues = o.openIssues ?? null;
  const pulls = o.openPulls ?? null;
  return counts([
    {
      icon: "issue",
      value: issues,
      label:
        o.issuesIncludePulls === true
          ? `${issues} open issues and pull requests`
          : `${issues} open issue${issues === 1 ? "" : "s"}`,
    },
    {
      icon: "pull",
      value: pulls,
      label: `${pulls} open pull request${pulls === 1 ? "" : "s"}`,
    },
  ]);
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

/** A chart series' swatch: the dot in the `--series-N` colour its bars wear. */
export function seriesDot(series: number): Html {
  return html`<span class="dot" data-series="${series}" aria-hidden="true"></span>`;
}

/**
 * A share as a bar: a whole percentage, 0–100, and what it is a share of in
 * words for a screen reader. `attn` when the share is a limit reached.
 */
export function meter(percent: number, label: string, tone?: "attn"): Html {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return html`<meter
    min="0"
    max="100"
    value="${value}"
    aria-label="${label}"
    ${tone ? html`data-tone="${tone}"` : null}
  >${value}%</meter>`;
}

/**
 * A drawn chart in the box that holds its space: `drawChart`'s svg `.chart`
 * inside `.chart-box`, which a table panel marks `.is-table`.
 */
export function chartBox(chart: Chart, cells: readonly Cell[], title: string): Html {
  return html`<div class="chart-box${chart === "table" ? " is-table" : ""}">${raw(drawChart(chart, cells, title))}</div>`;
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

/** The key of an action, as an attribute: it takes no room at rest, shows as a
 * tooltip on hover or focus, and as an overlay while hints are held (#8930). An
 * icon-only control passes its `name`, so the tooltip is its only one (no `title`). */
export function hintAttr(shortcut: string, name?: string): Html {
  const label = name === undefined ? shortcut : `${name} · ${shortcut}`;
  // aria-keyshortcuts lists alternatives, not sequences: a chord like `g h`
  // would read as "g or h", so only a single key is announced; the help lists the rest.
  return shortcut.includes(" ")
    ? html`data-hint="${label}"`
    : html`data-hint="${label}" aria-keyshortcuts="${shortcut}"`;
}

/** The keys of a `g i`-style shortcut in a menu or palette row, where a column
 * holds it (`.keyhint`). Never beside a button, tab or the top bar: those use
 * `hintAttr`, and design-lint refuses a `keyHint(` outside a menu item. */
export function keyHint(shortcut: string): Html {
  return html`<kbd class="keyhint">${shortcut}</kbd>`;
}

// ---- identity ----

/** Twelve stable buckets, so the same name always wears the same hue. */
export function hueOf(name: string): number {
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
export function userTag(
  username: string,
  o: { avatar?: boolean; mark?: Mark | undefined } = {},
): Html {
  return html`<span class="byline"
    >${o.avatar === false ? null : avatar(username)}<span class="byline-name"
      >${username}</span
    >${nameMark(o.mark)}</span
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

/**
 * The mark beside a name that says who it is: the owner's, the crew's
 * (`core/marks.ts`). Drawn by the forge from the account, never from a
 * display name; the `data-mark` attribute is what a typed name cannot make.
 */
export function nameMark(mark: Mark | undefined): Html | null {
  if (mark === undefined) return null;
  return html`<span
    class="name-mark"
    data-mark="${mark}"
    title="${mark === "owner" ? "The owner of this forge" : "An agent on the crew"}"
    >${mark}</span
  >`;
}

/** An author: avatar plus a link to their profile, and their mark. Never bare text. */
export function userLink(
  username: string,
  o: { avatar?: boolean; display?: string; mark?: Mark | undefined } = {},
): Html {
  return html`<span class="byline"
    >${o.avatar === false ? null : avatar(username)}<a href="/${username}"
      >${o.display || username}</a
    >${nameMark(o.mark)}</span
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
  /** Further attributes for the card itself (data hooks, tabindex), already escaped. */
  attrs?: Html;
}

export function card(body: Html, o: CardOptions = {}): Html {
  return html`<div
    class="card${o.extra ? ` ${o.extra}` : ""}"
    ${o.id ? html`id="${o.id}"` : null}
    ${o.attrs ?? null}
    ${o.tone && o.tone !== "default" ? html`data-tone="${o.tone}"` : null}
  >
    ${o.head ? html`<div class="card-head">${o.head}</div>` : null}
    ${o.pad === false ? body : html`<div class="card-body">${body}</div>`}
    ${o.foot ? html`<div class="card-foot">${o.foot}</div>` : null}
  </div>`;
}

/** Written text kept as typed (a commit message, a report body): §5's prose, wrapped. */
export function messageText(text: string): Html {
  return html`<div class="prose" data-text="message"><pre>${text}</pre></div>`;
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

export interface DisclosureOptions {
  /** A small muted summary, for a disclosure tucked under a card or a strip. */
  small?: boolean;
  /** The summary's accessible name, when its visible words are shorter. */
  label?: string;
  /** Further classes for the `<details>` (a spacing utility such as `mt`). */
  extra?: string;
  /** The `<details>`'s id, for a script or a link that finds it. */
  id?: string;
}

/** What a person sometimes needs, closed until asked for: a quiet chevron summary over its body. */
export function disclosure(summary: Html | string, body: Html | string, o: DisclosureOptions = {}): Html {
  return html`<details${o.id ? html` id="${o.id}"` : null} class="disclosure${o.extra ? ` ${o.extra}` : ""}">
    <summary${o.small ? html` class="muted small"` : null}${o.label ? html` aria-label="${o.label}"` : null}>${summary}</summary>
    ${body}
  </details>`;
}

export interface RowOptions {
  href?: string;
  title: Html | string;
  meta?: Html;
  /** Facts about the row, one `dt`/`dd` pair each, in a `dl.row-facts` under the meta. With facts the row's
   * main column is a `<div>`, so the `dl` is valid HTML: not for a `fold` row, whose `<summary>` takes phrasing only. */
  facts?: readonly { label: string; value: Html | string }[];
  /** Draw `.row-meta` even when `meta` is empty, for a script to write into. */
  metaSlot?: boolean;
  lead?: Html;
  trail?: Html;
  state?: "open" | "closed" | "merged" | "draft";
  /** The row joins `j`/`k` keyboard traversal. */
  nav?: boolean;
  /** An anchor for the row's `<li>`, so a redirect can land on it. */
  id?: string;
  titleAttr?: string;
  /** `data-*` hooks on the row's `<li>` (a script's filter, a test's
   * handle). Keys are lower-case words and dashes; others are dropped. */
  data?: Readonly<Record<string, string>>;
  /** The row is the one chosen (`aria-current="true"`). */
  current?: boolean;
  /** The rows under this one, already drawn (`row()`s): a nested `<ul>` inside
   * the `<li>`, so a tree stays a tree to assistive tech and with no script. */
  children?: readonly Html[];
  /** A control beside the row, outside its link (a form cannot sit inside an `<a>`). */
  after?: Html;
  /** The row folds: it is the `<summary>` of a `<details>` holding `body`,
   * open when `open` says so. Its `lead` is the caret. */
  fold?: { id: string; open: boolean; body: Html };
}

/** One list row. `<a>` when it navigates, `<div>` when it holds its own
 * controls, `<summary>` when it folds — the hover affordance follows
 * automatically. */
export function row(o: RowOptions): Html {
  const facts = o.facts !== undefined && o.facts.length > 0 && o.fold === undefined;
  const inner = html`${o.lead
      ? html`<span class="row-lead">${o.lead}</span>`
      : null}
    ${facts ? html`<div class="row-main">
      <span
        class="row-title"
        ${o.titleAttr ? html`title="${o.titleAttr}"` : null}
        >${o.title}</span
      >
      ${o.meta || o.metaSlot ? html`<span class="row-meta">${o.meta}</span>` : null}
      <dl class="row-facts">${o.facts!.map((f) => html`<div><dt>${f.label}</dt><dd>${f.value}</dd></div>`)}</dl>
    </div>` : html`<span class="row-main">
      <span
        class="row-title"
        ${o.titleAttr ? html`title="${o.titleAttr}"` : null}
        >${o.title}</span
      >
      ${o.meta || o.metaSlot ? html`<span class="row-meta">${o.meta}</span>` : null}
    </span>`}
    ${o.trail && o.trail.text.trim() !== ""
      ? html`<span class="row-trail">${o.trail}</span>`
      : null}`;
  const attrs = html`class="row"
  ${o.state ? html`data-state="${o.state}"` : null}
  ${o.nav ? raw('data-nav tabindex="-1"') : null}`;
  const data = Object.entries(o.data ?? {})
    .filter(([key]) => /^[a-z][a-z-]*$/.test(key))
    .map(([key, value]) => html` data-${raw(key)}="${value}"`);
  return html`<li${o.id === undefined ? null : html` id="${o.id}"`}${o.after === undefined ? null : raw(' class="has-after"')}${data}${o.current ? raw(' aria-current="true"') : null}>
    ${o.fold !== undefined
      ? html`<details id="${o.fold.id}" ${o.fold.open ? raw("open") : null}>
          <summary ${attrs}>${inner}</summary>
          ${o.fold.body}
        </details>`
      : o.href !== undefined
      ? html`<a href="${o.href}" ${attrs}>${inner}</a>`
      : html`<div ${attrs}>${inner}</div>`}${o.after === undefined ? null : html`<div class="row-after">${o.after}</div>`}${o.children === undefined || o.children.length === 0
      ? null
      : html`<ul class="row-children">${[...o.children]}</ul>`}
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
          ${t.shortcut ? html`data-shortcut="${t.shortcut}" ${hintAttr(t.shortcut)}` : null}
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
  /** A non-interactive group label. */
  heading?: boolean;
  /** Renders as a submit button inside its own POST form. */
  post?: string;
  /** Shown but not usable: the reason, in words, under the label. */
  disabled?: string;
  /** The key that does the same, drawn beside the label. */
  hint?: string;
  /** The link's tooltip; escaped. Absent, no title renders. */
  title?: string;
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
        if (i.heading) return html`<span class="menu-title">${i.label}</span>`;
        if (i.disabled !== undefined) {
          return html`<span class="menu-item" aria-disabled="true" title="${i.disabled}"
            >${i.icon ? icon(i.icon) : null}<span class="grow"
              >${i.label}<small class="muted">${i.disabled}</small></span
            ></span
          >`;
        }
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
          ${i.current ? raw('aria-current="true"') : i.title ? html`title="${i.title}"` : null}
          >${i.icon ? icon(i.icon) : null}<span class="grow">${i.label}</span
          >${i.hint ? keyHint(i.hint) : null}${i.current ? icon("check") : null}</a
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
  readonly?: boolean;
  autocomplete?: string;
  placeholder?: string;
  pattern?: string;
  minlength?: number;
  maxlength?: number;
  rows?: number;
  mono?: boolean;
  /** `false` for names and paths, which a spelling checker only underlines. */
  spellcheck?: boolean;
  id?: string;
  /** `type: "number"`'s bounds and step. */
  min?: number;
  max?: number;
  step?: string;
  /** `type: "checkbox"`: whether it is ticked; `value` is what it sends. */
  checked?: boolean;
  /** `type: "select"`: the choices, in order. */
  options?: readonly { value: string; label: string; selected?: boolean }[];
  /** Shown but not sent (a read-only view of a checkbox or a select). */
  disabled?: boolean;
  /** The label is for a screen reader only (a chip in a row of them). */
  labelHidden?: boolean;
  /** Drawn right after the control, before the hint: a chip's Remove. */
  after?: Html;
}

/** Label, control, hint and error, wired together with `aria-describedby`. */
export function field(o: FieldOptions): Html {
  const id = o.id ?? `f-${o.name}`;
  const described = [o.hint ? `${id}-hint` : "", o.error ? `${id}-err` : ""]
    .filter(Boolean)
    .join(" ");
  const aria = html`${described !== "" ? html`aria-describedby="${described}"` : null}
  ${o.error ? raw('aria-invalid="true"') : null}
  ${o.disabled ? raw("disabled") : null}`;
  const shared = html`class="input${o.mono ? " mono" : ""}" id="${id}"
  name="${o.name}"
  ${aria}
  ${o.required ? raw("required") : null}
  ${o.autofocus ? raw("autofocus") : null}
  ${o.readonly ? raw("readonly") : null}
  ${o.placeholder ? html`placeholder="${o.placeholder}"` : null}
  ${o.spellcheck === false ? raw('spellcheck="false"') : null}`;
  const control =
    o.type === "textarea"
      ? html`<textarea ${shared} rows="${o.rows ?? 6}" data-grow>
${o.value ?? ""}</textarea
        >`
      : o.type === "select"
        ? html`<select ${shared}>
            ${(o.options ?? []).map(
              (c) => html`<option value="${c.value}" ${c.selected ? raw("selected") : null}>${c.label}</option>`,
            )}
          </select>`
        : html`<input
          ${o.type === "checkbox" ? html`id="${id}" name="${o.name}" ${aria}` : shared}
          type="${o.type ?? "text"}"
          value="${o.value ?? ""}"
          ${o.checked ? raw("checked") : null}
          ${o.autocomplete ? html`autocomplete="${o.autocomplete}"` : null}
          ${o.pattern ? html`pattern="${o.pattern}"` : null}
          ${o.minlength !== undefined ? html`minlength="${o.minlength}"` : null}
          ${o.maxlength !== undefined ? html`maxlength="${o.maxlength}"` : null}
          ${o.min !== undefined ? html`min="${String(o.min)}"` : null}
          ${o.max !== undefined ? html`max="${String(o.max)}"` : null}
          ${o.step !== undefined ? html`step="${o.step}"` : null}
        />`;
  const label =
    o.type === "checkbox"
      ? html`<label class="check">${control} ${o.label}</label>`
      : o.labelHidden
        ? html`<label for="${id}" class="sr-only">${o.label}</label>${control}`
        : html`<label for="${id}">${o.label}</label>
    ${control}`;
  return html`<div class="field" ${o.error ? raw("data-invalid") : null}>
    ${label}
    ${o.after ?? null}
    ${o.hint ? html`<span class="hint" id="${id}-hint">${o.hint}</span>` : null}
    ${o.error
      ? html`<span class="error" id="${id}-err">${o.error}</span>`
      : null}
  </div>`;
}

/** A `<select>` with the same anatomy as `field`: hint and error are linked and marked. */
export function selectField(
  o: Omit<FieldOptions, "type"> & {
    options: { value: string; label: string; selected?: boolean }[];
  },
): Html {
  const id = o.id ?? `f-${o.name}`;
  const described = [o.hint ? `${id}-hint` : "", o.error ? `${id}-err` : ""]
    .filter(Boolean)
    .join(" ");
  return html`<div class="field" ${o.error ? raw("data-invalid") : null}>
    <label for="${id}">${o.label}</label>
    <select class="input" id="${id}" name="${o.name}"
      ${described !== "" ? html`aria-describedby="${described}"` : null}
      ${o.error ? raw('aria-invalid="true"') : null}
    >
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
    ${o.hint ? html`<span class="hint" id="${id}-hint">${o.hint}</span>` : null}
    ${o.error
      ? html`<span class="error" id="${id}-err">${o.error}</span>`
      : null}
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
  /** The accessible name, when the verb alone is ambiguous (one of many rows). */
  label?: string;
}): Html {
  return btn(o.verb, {
    href: `/-/confirm?to=${encodeURIComponent(o.action)}`,
    variant: "danger",
    ...(o.size ? { size: o.size } : {}),
    ...(o.label ? { label: o.label } : {}),
  });
}

// ---- states ----

export function empty(o: {
  icon?: IconName;
  title: string;
  note?: string;
  action?: Html;
}): Html {
  return html`<div class="empty">
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
