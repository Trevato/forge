/**
 * The conversation parts an issue and a pull request share: a timeline of
 * markdown bodies, and the composer that adds to it.
 *
 * Timeline entries are rendered as styled lines rather than through
 * `timelineItem`, because a comment body is markdown and must be able to
 * carry a code block — the widget takes plain strings by design.
 */

import type { Ctx } from "../app/app.ts";
import type { KeyEvent } from "../term/input.ts";
import {
  G,
  type Rect,
  type Screen as Surface,
  type Span,
} from "../term/screen.ts";
import { BOLD, ITALIC, style } from "../term/style.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { Textarea } from "../ui/textarea.ts";
import type { Tokens } from "../ui/theme.ts";
import {
  avatarStyle,
  card,
  initials,
  readableOn,
  type Tone,
} from "../ui/widgets.ts";
import { ago } from "./common.ts";

/**
 * The `badge()` widget paints straight onto the surface; a timeline is spans.
 * Same colours, same reading — one chip, the tone's ground, a foreground
 * derived rather than stored so any palette stays legible.
 */
function badgeStyle(c: Tokens, tone: Tone): ReturnType<typeof style> {
  if (tone === "outline" || tone === "default")
    return style(c.mutedFg, c.muted, BOLD);
  const bg =
    tone === "success"
      ? c.success
      : tone === "danger"
        ? c.danger
        : tone === "merged"
          ? c.merged
          : tone === "attn"
            ? c.attn
            : c.mutedFg;
  return style(readableOn(bg), bg, BOLD);
}

export interface ThreadEntry {
  readonly kind: "comment" | "event";
  readonly actor: string;
  readonly at: string;
  readonly body: string;
  /** Shown after the author, e.g. "outdated" or a review anchor. */
  readonly note?: string;
  /**
   * A verdict, as a chip before the author: `approved`, `changes requested`.
   * The tone carries the meaning at a glance — a conversation is scanned,
   * not read, and "did anybody approve this" must be answerable from the
   * shape of the column rather than from the words in it.
   */
  readonly badge?: { readonly text: string; readonly tone: Tone };
}

/** A timeline as styled lines: header row, then the body behind a rule. */
export function threadLines(
  entries: readonly ThreadEntry[],
  width: number,
  c: Tokens,
): Span[][] {
  const out: Span[][] = [];
  for (const entry of entries) {
    // The same swatch the web draws: one initial on a hue keyed to the name.
    const header: Span[] = [
      { text: ` ${initials(entry.actor)} `, style: avatarStyle(entry.actor) },
      { text: ` ${entry.actor}`, style: style(c.fg, c.bg, BOLD) },
      ...(entry.badge === undefined
        ? []
        : [
            { text: "  ", style: style(c.fg, c.bg) },
            {
              text: ` ${entry.badge.text} `,
              style: badgeStyle(c, entry.badge.tone),
            },
          ]),
      { text: `  ${ago(entry.at)}`, style: style(c.faint, c.bg) },
    ];
    if (entry.note !== undefined)
      header.push({
        text: `  ${entry.note}`,
        style: style(c.attn, c.bg, ITALIC),
      });
    out.push(header);
    if (entry.kind === "event") {
      out.push([]);
      continue;
    }
    const body = renderMarkdown(entry.body, Math.max(10, width - 3), c);
    for (const line of body)
      out.push([{ text: `${G.v}  `, style: style(c.border, c.bg) }, ...line]);
    out.push([]);
  }
  return out;
}

/**
 * The comment box. Closed by default so `j`/`k` stay navigation; while open
 * it owns every key, which is what lets Ctrl+D mean submit here and page-down
 * everywhere else without a conflict.
 */
export class Composer {
  private area: Textarea | null = null;
  title = "Comment";

  get open(): boolean {
    return this.area !== null;
  }

  get value(): string {
    return this.area?.value ?? "";
  }

  start(title = "Comment", initial = ""): void {
    this.title = title;
    this.area = new Textarea(initial);
  }

  /** Keep the text: a failed submit must never lose what was typed. */
  close(): void {
    this.area = null;
  }

  paste(text: string): boolean {
    if (!this.area) return false;
    this.area.paste(text);
    return true;
  }

  key(e: KeyEvent): "submit" | "cancel" | "typed" | null {
    if (!this.area) return null;
    const out = this.area.key(e);
    if (out === "submit") return "submit";
    if (out === "cancel") return "cancel";
    return "typed";
  }

  /** Height the composer wants, so a caller can reserve it in its split. */
  height(): number {
    return this.area === null ? 0 : 7;
  }

  render(s: Surface, r: Rect, c: Tokens, ctx: Ctx): void {
    if (!this.area || r.h <= 2) return;
    const inner = card(s, r, c, {
      title: this.title,
      footer: "ctrl+d submit · esc cancel",
      focused: true,
    });
    ctx.setCursor(this.area.render(s, inner, c, true));
  }
}
