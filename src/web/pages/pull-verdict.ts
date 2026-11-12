/**
 * What a pull's page opens on: one verdict line (can it land, and if not what
 * holds it, with the one action that moves it) and, directly under it, the
 * change itself. Reviews, checks and history come after.
 *
 * `verdictOf` is plain data in, plain data out; it asks the questions
 * `mergeBox` and `mergePull` ask, in the same order, so the line and the
 * button never disagree.
 */
import type { Diff } from "../../git/diff.ts";
import { html, when, type Html } from "../html.ts";
import { btn, dot, type Tone } from "../ui.ts";

export interface VerdictInput {
  readonly merged: boolean;
  readonly closed: boolean;
  /** A mirror: the merge belongs to the origin. */
  readonly onOrigin: boolean;
  readonly mergeable: boolean;
  readonly ahead: number;
  readonly conflicts: number;
  readonly baseBranch: string;
  /** The review gate refuses this head. */
  readonly reviewGated: boolean;
  /** A current review asked for changes. */
  readonly changesRequested: boolean;
  /** Teams whose reviewer has not approved this head. */
  readonly teamsHolding: number;
  /** The check gate refuses this head, and the check's state. */
  readonly checksHeld: boolean;
  readonly checkState: string;
  readonly mayMerge: boolean;
}

export interface Verdict {
  readonly tone: Tone | undefined;
  /** A fixed phrase of ours, never a person's text. */
  readonly words: string;
  readonly action: { readonly label: string; readonly href: string } | null;
}

/**
 * The verdict, from the same facts the merge box reads. `thread` is the pull's
 * address; `page` prefixes the in-page anchors when the line is drawn on a
 * page that does not hold the merge box itself.
 */
export function verdictOf(v: VerdictInput, thread: string, page = ""): Verdict {
  if (v.merged) return { tone: "merged", words: "Merged", action: null };
  if (v.closed) return { tone: undefined, words: "Closed without merging", action: null };
  if (v.onOrigin) return { tone: "attn", words: "Merges on the origin", action: null };
  if (!v.mergeable) {
    if (v.ahead === 0) return { tone: "danger", words: "Nothing left to apply", action: null };
    if (v.conflicts > 0)
      return {
        tone: "danger",
        words: `Conflicts with ${v.baseBranch}`,
        action: v.mayMerge ? { label: "Resolve", href: `${thread}/resolve` } : null,
      };
    return { tone: "danger", words: "Cannot be applied automatically", action: null };
  }
  if (v.reviewGated)
    return {
      tone: "attn",
      words: v.changesRequested ? "A reviewer asked for changes" : "Waiting for a review",
      action: { label: "Review", href: `${page}#review-body` },
    };
  if (v.teamsHolding > 0)
    return {
      tone: "attn",
      words: v.teamsHolding === 1 ? "Waiting for a team's review" : "Waiting for teams' reviews",
      action: { label: "Review", href: `${page}#review-body` },
    };
  if (v.checksHeld)
    return {
      tone: v.checkState === "failed" ? "danger" : "attn",
      words: v.checkState === "failed" ? "The check failed" : "Waiting for the check",
      action: { label: "See the check", href: `${page}#merge` },
    };
  return {
    tone: "success",
    words: "Ready to land",
    action: v.mayMerge ? { label: "Go to merge", href: `${page}#merge` } : null,
  };
}

/** The verdict as the first line of the page: the dot, the words, the action. */
export function verdictLine(verdict: Verdict, show: { readonly action?: boolean } = {}): Html {
  return html`<div class="bar mt" data-verdict role="status">
    ${dot(verdict.tone)}
    <strong>${verdict.words}</strong>
    ${when(show.action === false ? null : verdict.action, (a) => btn(a.label, { href: a.href, size: "sm", ...(verdict.tone === "success" ? { variant: "primary" as const } : {}) }))}
  </div>`;
}

/** The first paragraph of a description, as text. */
export function firstParagraph(body: string): string {
  for (const part of body.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const text = part.trim();
    if (text !== "") return text.length > 400 ? `${text.slice(0, 400).trimEnd()}…` : text;
  }
  return "";
}

/**
 * The change itself, once: the description's first paragraph and the total.
 * The file list is the diff's own rows, one click away at `filesHref`.
 */
export function changeSummary(body: string, diff: Diff | null, filesHref: string): Html {
  const lead = firstParagraph(body);
  return html`<section class="mt" data-change>
    ${when(lead, (text) => html`<p>${text}</p>`)}
    ${when(
      diff,
      (d) => html`<p class="muted small">
        <a href="${filesHref}">${d.files.length} file${d.files.length === 1 ? "" : "s"}</a> ·
        <span class="mono">+${d.additions} −${d.deletions}</span>
      </p>`,
    )}
  </section>`;
}
