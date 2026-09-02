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
import { card, initials } from "../ui/widgets.ts";
import { relTime } from "./common.ts";

export interface ThreadEntry {
  readonly kind: "comment" | "event";
  readonly actor: string;
  readonly at: string;
  readonly body: string;
  /** Shown after the author, e.g. "outdated" or a review anchor. */
  readonly note?: string;
}

/** A timeline as styled lines: header row, then the body behind a rule. */
export function threadLines(
  entries: readonly ThreadEntry[],
  width: number,
  c: Tokens,
): Span[][] {
  const out: Span[][] = [];
  for (const entry of entries) {
    const header: Span[] = [
      { text: initials(entry.actor), style: style(c.accentFg, c.accent) },
      { text: ` ${entry.actor}`, style: style(c.fg, c.bg, BOLD) },
      { text: `  ${relTime(entry.at)}`, style: style(c.faint, c.bg) },
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
