/**
 * The vocabulary every forge screen shares: a list cursor, a scroll offset, a
 * filter-as-you-type box, three modal screens, and the one place a `Result`
 * error code becomes a sentence a person can read.
 *
 * Screens stay short because these carry the parts that are identical in all
 * of them. Nothing here knows about repos or issues — that is the point.
 */

import { PASSWORD_TOO_LONG } from "../../core/hash-gate.ts";
import { refusalText } from "../../http/refusal.ts";
import { NOT_A_MEMBER } from "../../core/roles.ts";
import { AGENT_NOT_ON_CREW } from "../../actions/crew_limit_words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import { ARCHIVED_WHY, type RepoCounts } from "../../core/repos.ts";
import { SIGNUP_CLOSED_MESSAGE } from "../../actions/users.ts";
import { ORIGIN_ALREADY_CONNECTED } from "../../actions/origins.ts";
import { NEW_ACCOUNT_GUARD_MESSAGE } from "../../core/capacity.ts";
import { PRIVATE_ADDRESS_REFUSED } from "../../kernel/address_words.ts";
import type { ForgeEvent } from "../../core/events.ts";
import type { Session } from "../session.ts";
import { G, Screen as Surface, type Rect } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { pad, truncate, wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { drawQr, qrSize, terminalQr } from "../ui/qr.ts";
import type { Tokens } from "../ui/theme.ts";
import { icon, type IconSet } from "../ui/icons.ts";
import {
  card,
  dialog,
  DIALOG_CHROME_ROWS,
  input,
  row,
  scrollbar,
  type ButtonVariant,
  type Tone,
} from "../ui/widgets.ts";

// ---- list cursor ----

/**
 * A selection index plus the scroll offset that keeps it on screen. The two
 * belong together: every list bug is one of them updated without the other.
 */
export class ListState {
  index = 0;
  offset = 0;
  /** Rows the last render had room for — what `ctrl+d` pages by. */
  height = 10;
  /** Screen rows each drawn item took, from `offset`, when some item had a note; else undefined. */
  heights: number[] | undefined;

  /** The item at list row `y`: where a click landed, however tall the items above it. */
  at(y: number): number {
    if (this.heights === undefined) return this.offset + y;
    let top = 0;
    for (let i = 0; i < this.heights.length; i++) {
      top += this.heights[i]!;
      if (y < top) return this.offset + i;
    }
    return -1;
  }

  clamp(length: number): void {
    this.index = Math.max(0, Math.min(this.index, Math.max(0, length - 1)));
  }

  move(delta: number, length: number): void {
    this.index = Math.max(
      0,
      Math.min(this.index + delta, Math.max(0, length - 1)),
    );
  }

  /** Scroll so the cursor is visible; returns the first row to draw. */
  window(height: number, length: number): number {
    this.height = Math.max(1, height);
    this.clamp(length);
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + this.height)
      this.offset = this.index - this.height + 1;
    this.offset = Math.max(
      0,
      Math.min(this.offset, Math.max(0, length - this.height)),
    );
    return this.offset;
  }

  /**
   * As `window`, for rows taller than one line: row `i` takes `heights[i]`
   * lines. The cursor's row is kept whole on screen, and no room is left
   * empty at the bottom while rows above could fill it.
   */
  windowRows(height: number, heights: readonly number[]): number {
    this.height = Math.max(1, height);
    this.clamp(heights.length);
    const span = (from: number, to: number): number => {
      let n = 0;
      for (let i = from; i <= to; i++) n += heights[i] ?? 1;
      return n;
    };
    if (this.index < this.offset) this.offset = this.index;
    while (this.offset < this.index && span(this.offset, this.index) > height) this.offset++;
    while (this.offset > 0 && span(this.offset - 1, heights.length - 1) <= height) this.offset--;
    return this.offset;
  }

  /** The convergent navigation set. True when the key was ours. */
  key(e: KeyEvent, length: number): boolean {
    const half = Math.max(1, this.height >> 1);
    if (e.ctrl && e.key === "d") return this.take(half, length);
    if (e.ctrl && e.key === "u") return this.take(-half, length);
    // Ctrl+K is the palette and Alt+j is nobody's: a modified key is never a
    // movement, and swallowing one here would steal a global binding.
    if (e.ctrl || e.alt) return false;
    if (e.key === "pgdn") return this.take(this.height, length);
    if (e.key === "pgup") return this.take(-this.height, length);
    if (e.key === "j" || e.key === "down") return this.take(1, length);
    if (e.key === "k" || e.key === "up") return this.take(-1, length);
    if (e.key === "g" || e.key === "home") return this.jump(0, length);
    if (e.key === "G" || e.key === "end") return this.jump(length - 1, length);
    return false;
  }

  private take(delta: number, length: number): boolean {
    this.move(delta, length);
    return true;
  }

  private jump(to: number, length: number): boolean {
    this.index = to;
    this.clamp(length);
    return true;
  }
}

/** A cursorless viewport — long text, a diff, a rendered README. */
export class Scroll {
  top = 0;
  height = 10;

  window(height: number, total: number): number {
    this.height = Math.max(1, height);
    this.top = Math.max(0, Math.min(this.top, Math.max(0, total - 1)));
    return this.top;
  }

  to(line: number, total: number): void {
    this.top = Math.max(0, Math.min(line, Math.max(0, total - 1)));
  }

  key(e: KeyEvent, total: number): boolean {
    const half = Math.max(1, this.height >> 1);
    if (e.ctrl && e.key === "d") return this.by(half, total);
    if (e.ctrl && e.key === "u") return this.by(-half, total);
    if (e.ctrl || e.alt) return false;
    if (e.key === "pgdn") return this.by(this.height, total);
    if (e.key === "pgup") return this.by(-this.height, total);
    if (e.key === "j" || e.key === "down") return this.by(1, total);
    if (e.key === "k" || e.key === "up") return this.by(-1, total);
    if (e.key === "g" || e.key === "home") return this.by(-total, total);
    if (e.key === "G" || e.key === "end") return this.by(total, total);
    return false;
  }

  private by(delta: number, total: number): boolean {
    this.to(this.top + delta, total);
    return true;
  }
}

// ---- filter-as-you-type ----

/** `/` opens it, Esc clears it, Enter keeps it and returns focus to the list. */
export class Filter {
  active = false;
  query = "";

  get on(): boolean {
    return this.active || this.query !== "";
  }

  open(): void {
    this.active = true;
  }

  /** True when the key belonged to the filter. */
  key(e: KeyEvent): boolean {
    if (!this.active) {
      if (e.key === "/" && !e.ctrl && !e.alt) {
        this.active = true;
        return true;
      }
      return false;
    }
    if (e.key === "esc") {
      this.active = false;
      this.query = "";
      return true;
    }
    if (e.key === "enter") {
      this.active = false;
      return true;
    }
    if (e.key === "backspace") {
      this.query = [...this.query].slice(0, -1).join("");
      return true;
    }
    if (!e.ctrl && !e.alt && [...e.key].length === 1) {
      this.query += e.key;
      return true;
    }
    return false;
  }

  matches(haystack: string): boolean {
    return (
      this.query === "" ||
      haystack.toLowerCase().includes(this.query.toLowerCase())
    );
  }

  /** Draw the box and return where the caret belongs, or null when idle. */
  render(
    s: Surface,
    r: Rect,
    c: Tokens,
    placeholder: string,
  ): { x: number; y: number } | null {
    return input(s, r, c, {
      value: this.query,
      placeholder,
      focused: this.active,
      ...(this.active ? { cursor: [...this.query].length } : {}),
    });
  }
}

// ---- drawing helpers ----

export interface ListRow {
  readonly title: string;
  readonly state?: "open" | "closed" | "merged" | "draft";
  /** A status row's lead dot — see `RowOpts.tone`. */
  readonly tone?: Tone;
  readonly hollow?: boolean;
  readonly secondary?: string;
  readonly meta?: string;
  /** A muted line under the row, indented past its dot; the item is then two rows tall. */
  readonly note?: string;
  /** Muted sentences under the row, wrapped to the list's width, never cut; the item is as tall as they wrap. */
  readonly below?: readonly string[];
}

/** Lines under a row start past its caret and dot. */
const UNDER_INDENT = 4;

/**
 * A scrolling list of `row()`s with a scrollbar when it overflows. A row with
 * `note` is two lines tall; one with `below` lines, as many as they wrap to.
 */
export function drawList(
  s: Surface,
  r: Rect,
  c: Tokens,
  state: ListState,
  rows: readonly ListRow[],
  focused = true,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const body = { x: r.x, y: r.y, w: Math.max(0, r.w - 1), h: r.h };
  const room = Math.max(1, body.w - UNDER_INDENT);
  const under = rows.map((item): string[] =>
    item.note
      ? body.w > UNDER_INDENT ? [truncate(item.note, room)] : [""]
      : (item.below ?? []).flatMap((line) => wrap(line, room)),
  );
  const tall = under.some((lines) => lines.length > 0);
  // Scroll by item, so the cursor's whole entry (row and the lines under it) is in view.
  const from = tall
    ? state.windowRows(r.h, under.map((lines) => 1 + lines.length))
    : state.window(r.h, rows.length);
  let y = body.y;
  const heights: number[] = [];
  for (let i = from; i < rows.length && y < body.y + body.h; i++) {
    const top = y;
    row(s, { x: body.x, y, w: body.w, h: 1 }, c, {
      ...rows[i]!,
      selected: focused && i === state.index,
      focused: i === state.index,
    });
    y++;
    for (const line of under[i]!) {
      if (y >= body.y + body.h) break;
      s.text(body.x + UNDER_INDENT, y, line, style(c.mutedFg, c.bg), body.x + body.w);
      y++;
    }
    heights.push(y - top);
  }
  state.heights = tall ? heights : undefined;
  if (tall) state.height = Math.max(1, heights.length);
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total: rows.length,
    offset: from,
  });
}

// ---- the pointer ----

export interface ListHits {
  /** A click that moved the cursor onto a row it was not already on. */
  select?(index: number): void;
  /** A click on the selected row, or a double-click on any row. */
  open?(index: number): void;
  /** A wheel notch, in rows. Defaults to moving the cursor. */
  scroll?(rows: number): void;
}

/**
 * Make a list the pointer can drive, with the gesture a file manager taught
 * everyone: a click selects, and a click on what is already selected — or a
 * double-click on anything — opens. That is deliberately *not* "one click
 * opens". A single click has to be safe, because half of pointing at a row is
 * looking at it, and a list where looking navigates is a list you cannot
 * browse.
 *
 * One region for the whole body rather than one per row: the geometry is
 * `state.offset + y`, the same arithmetic `drawList` already did to paint it,
 * so the two cannot disagree about which row is where.
 */
export function hitList(
  ctx: Ctx,
  r: Rect,
  state: ListState,
  count: number,
  on: ListHits,
): void {
  ctx.hit(r, {
    click: (e) => {
      const index = state.at(e.y);
      if (index < 0 || index >= count) return;
      if (index === state.index || e.double) {
        state.index = index;
        on.open?.(index);
        return;
      }
      state.index = index;
      on.select?.(index);
    },
    wheel: (rows) => {
      if (on.scroll !== undefined) {
        on.scroll(rows);
        return;
      }
      state.move(rows, count);
    },
  });
}

/** The same, for a cursorless viewport: the wheel moves the text. */
export function hitScroll(
  ctx: Ctx,
  r: Rect,
  scroll: Scroll,
  total: number,
): void {
  ctx.hit(r, { wheel: (rows) => scroll.to(scroll.top + rows, total) });
}

/** Draw pre-styled lines (markdown, a diff) into a scrolled viewport. */
export function drawLines(
  s: Surface,
  r: Rect,
  c: Tokens,
  scroll: Scroll,
  lines: readonly { text: string; style: ReturnType<typeof style> }[][],
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const from = scroll.window(r.h, lines.length);
  const body = { ...r, w: Math.max(0, r.w - 1) };
  for (let i = 0; i < r.h; i++) {
    const line = lines[from + i];
    if (line === undefined) break;
    s.spans(body.x, body.y + i, line, body.x + body.w);
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total: lines.length,
    offset: from,
  });
}

/**
 * A label/value column — the "about" blocks every detail screen carries.
 *
 * A value that *is* a URL is emitted as an OSC 8 hyperlink, so the clone line
 * and the page link on a repo's front door are clickable in every terminal
 * that supports them and unchanged in every one that does not. `bg` matters
 * here: these blocks live inside cards as often as not.
 */
export function drawFacts(
  s: Surface,
  r: Rect,
  c: Tokens,
  facts: readonly (readonly [string, string])[],
  bg = c.bg,
): void {
  facts.forEach(([label, value], i) => {
    if (i >= r.h) return;
    const y = r.y + i;
    s.text(r.x, y, truncate(label, 14), style(c.mutedFg, bg), r.x + r.w);
    linkedText(
      s,
      r.x + 15,
      y,
      truncate(value, Math.max(0, r.w - 15)),
      style(c.fg, bg),
      r.x + r.w,
    );
  });
}

/** Every http(s) URL inside `text` becomes a link; the rest is plain. */
export function linkedText(
  s: Surface,
  x: number,
  y: number,
  text: string,
  st: ReturnType<typeof style>,
  right: number,
): number {
  const pattern = /https?:\/\/[^\s<>"']+/g;
  let cx = x;
  let at = 0;
  for (const hit of text.matchAll(pattern)) {
    const start = hit.index;
    if (start > at) cx = s.text(cx, y, text.slice(at, start), st, right);
    cx = s.linkText(cx, y, hit[0], st, hit[0], right);
    at = start + hit[0].length;
  }
  if (at < text.length) cx = s.text(cx, y, text.slice(at), st, right);
  return cx;
}

// ---- modal screens ----

/**
 * Modality is structural: a dialog screen draws its parent, paints over it,
 * and returns true from `key()` for everything. Nothing beneath can act.
 */
export function confirmScreen(
  ctx: Ctx,
  parent: Screen,
  o: {
    title: string;
    body: readonly string[];
    actions: readonly { label: string; variant?: ButtonVariant }[];
    /** Index of the action chosen; -1 when dismissed. */
    onChoose: (index: number) => void;
    selected?: number;
    /** `y` chooses the first action and `n` dismisses, for a plain yes/no question. */
    yesNo?: boolean;
    /** Columns of the dialog, for a body line longer than the default fits. */
    width?: number;
  },
): Screen {
  let selected = o.selected ?? 0;
  return {
    title: o.title,
    keys: [
      binding(["left", "right", "tab"], "choose"),
      binding(["enter"], "confirm"),
      binding(["esc"], "cancel"),
    ],
    render(area, s) {
      parent.render(area, s);
      const buttons = dialog(s, area, ctx.theme.c, {
        title: o.title,
        body: o.body,
        actions: o.actions,
        selected,
        ...(o.width !== undefined ? { width: o.width } : {}),
      });
      // Clicking a button *is* choosing it: a dialog has no browsing to do,
      // so the two-click rule that protects a list would only be in the way.
      buttons.forEach((rect, index) =>
        ctx.hit(rect, () => {
          ctx.pop();
          o.onChoose(index);
        }),
      );
    },
    key(e) {
      if (o.yesNo === true && (e.key === "y" || e.key === "n")) {
        ctx.pop();
        o.onChoose(e.key === "y" ? 0 : -1);
      } else if (e.key === "left" || e.key === "h")
        selected = Math.max(0, selected - 1);
      else if (e.key === "right" || e.key === "l" || e.key === "tab")
        selected = Math.min(o.actions.length - 1, selected + 1);
      else if (e.key === "enter") {
        ctx.pop();
        o.onChoose(selected);
      } else if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        o.onChoose(-1);
      }
      return true;
    },
  };
}

/**
 * A `… y/n` confirm: `y` chooses the first action and `n` cancels, whatever
 * the selection — each outright, rather than pressing Enter.
 */
export function yesNo(ctx: Ctx, dialog: Screen, choose: (choice: number) => void): Screen {
  return {
    ...dialog,
    key(e) {
      if (e.key === "y" || e.key === "n") {
        ctx.pop();
        choose(e.key === "y" ? 0 : -1);
        return true;
      }
      return dialog.key(e);
    },
  };
}

/** A one-field modal: a name to type, a username to add, a branch to create. */
export function promptScreen(
  ctx: Ctx,
  parent: Screen,
  o: {
    title: string;
    label: string;
    placeholder?: string;
    value?: string;
    hint?: string;
    /**
     * Show the value as dots. A terminal is the one surface where somebody
     * is routinely reading over your shoulder, so a secret typed into one
     * must never be a plain string of cells. A masked value is also kept
     * verbatim: not trimmed, and a paste keeps its newlines.
     */
    mask?: boolean;
    /** Return an error string to keep the prompt open with a message. */
    onSubmit: (value: string) => string | undefined | Promise<void>;
  },
): Screen {
  let value = o.value ?? "";
  let error: string | undefined;
  return {
    title: o.title,
    keys: [binding(["enter"], "submit"), binding(["esc"], "cancel")],
    render(area, s) {
      parent.render(area, s);
      const c = ctx.theme.c;
      dialog(s, area, c, {
        title: o.title,
        body: ["", "", error ?? o.hint ?? ""],
        actions: [{ label: "Cancel", variant: "ghost" }, { label: "OK" }],
        selected: 1,
      });
      // The dialog reserved three body rows; the field goes in the first two.
      const w = Math.min(54, area.w - 4);
      const x = area.x + ((area.w - w) >> 1) + 2;
      const h = Math.min(9, area.h - 2);
      const y = area.y + ((area.h - h) >> 1) + 1;
      s.text(x, y, truncate(o.label, w - 4), style(c.mutedFg, c.card), x + w);
      const shown =
        o.mask === true ? "\u2022".repeat([...value].length) : value;
      const cursor = input(s, { x, y: y + 1, w: w - 4, h: 1 }, c, {
        value: shown,
        cursor: [...value].length,
        focused: true,
        ...(o.placeholder === undefined ? {} : { placeholder: o.placeholder }),
        ...(error === undefined ? {} : { invalid: true }),
      });
      ctx.setCursor(cursor);
    },
    paste(text) {
      // A masked value is a credential: kept as pasted (a PEM key's lines), only CR/CRLF made LF.
      value += o.mask === true ? text.replace(/\r\n?/g, "\n") : text.replace(/\s+/g, " ");
      return true;
    },
    key(e) {
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.key === "enter") {
        const outcome = o.onSubmit(o.mask === true ? value : value.trim());
        if (typeof outcome === "string") {
          error = outcome;
          return true;
        }
        ctx.pop();
        if (outcome !== undefined)
          void outcome.catch((err: unknown) =>
            ctx.toast(message(err), "danger"),
          );
        return true;
      }
      if (e.key === "backspace") {
        value = [...value].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        value += e.key;
        error = undefined;
      }
      return true;
    },
  };
}

/**
 * Push the next screen of a flow *after* the current modal has popped.
 *
 * `promptScreen` calls `onSubmit` before it pops itself, so a screen pushed
 * synchronously from there is the one the pop removes. Returning this from
 * `onSubmit` defers the push by one microtask — after the pop, before the
 * next frame — which is what lets a flow chain prompts and pickers.
 */
export function later(ctx: Ctx, next: () => Screen): Promise<void> {
  return Promise.resolve().then(() => {
    ctx.push(next());
  });
}

export interface PickItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly tone?: Tone;
}

/**
 * A filterable list in a card: the ref picker, the label checkboxes, the merge
 * strategy. `multi` turns it into a checkbox list committed with Enter.
 */
export function pickerScreen(
  ctx: Ctx,
  parent: Screen,
  o: {
    title: string;
    items: readonly PickItem[];
    multi?: boolean;
    chosen?: readonly string[];
    onPick: (ids: string[]) => void;
  },
): Screen {
  const state = new ListState();
  const filter = new Filter();
  const chosen = new Set(o.chosen ?? []);
  const shown = (): PickItem[] =>
    o.items.filter((i) => filter.matches(i.label));
  const keys: Binding[] = [
    binding(["j", "k"], "move"),
    ...(o.multi === true
      ? [binding(["space"], "toggle"), binding(["enter"], "apply")]
      : [binding(["enter"], "choose")]),
    binding(["/"], "filter"),
    binding(["esc"], "cancel"),
  ];
  return {
    title: o.title,
    keys,
    render(area, s) {
      parent.render(area, s);
      const c = ctx.theme.c;
      const items = shown();
      const w = Math.min(52, Math.max(20, area.w - 6));
      const h = Math.min(area.h, Math.max(6, items.length + 5));
      const r = {
        x: area.x + ((area.w - w) >> 1),
        y: area.y + ((area.h - h) >> 1),
        w,
        h,
      };
      const inner = card(s, r, c, { title: o.title, focused: true });
      const [box, list] = split(inner, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "filter"));
      drawList(
        s,
        list!,
        c,
        state,
        items.map((item) => ({
          title:
            o.multi === true
              ? `${chosen.has(item.id) ? "[x]" : "[ ]"} ${item.label}`
              : item.label,
          ...(item.hint === undefined ? {} : { meta: item.hint }),
        })),
      );
      hitList(ctx, list!, state, items.length, {
        open: (index) => {
          const item = items[index];
          if (item === undefined) return;
          // A checkbox list toggles under the pointer and stays open; a
          // single-choice list is answered by the click that made it.
          if (o.multi === true) {
            if (chosen.has(item.id)) chosen.delete(item.id);
            else chosen.add(item.id);
            return;
          }
          ctx.pop();
          o.onPick([item.id]);
        },
      });
    },
    key(e) {
      const items = shown();
      if (e.key === "esc" && !filter.active) {
        ctx.pop();
        return true;
      }
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (state.key(e, items.length)) return true;
      const current = items[state.index];
      if (o.multi === true && e.key === " " && current) {
        if (chosen.has(current.id)) chosen.delete(current.id);
        else chosen.add(current.id);
        return true;
      }
      if (e.key === "enter") {
        ctx.pop();
        if (o.multi === true) o.onPick([...chosen]);
        else if (current) o.onPick([current.id]);
        return true;
      }
      return true;
    },
  };
}

// ---- realtime ----

/** How long events are gathered before one refresh runs. */
const LIVE_COALESCE_MS = 40;

export interface LiveOptions {
  /** Only events touching this repository. Omit for everything. */
  readonly repoId?: string;
  /** Only these event kinds. Omit for all of them. */
  readonly kinds?: readonly string[];
  /** Only events this accepts. Omit for all of them. */
  readonly where?: (event: ForgeEvent) => boolean;
}

/**
 * Keep a screen live for as long as it is on the stack.
 *
 * Every meaningful mutation appends to the outbox (invariant 5), so "realtime"
 * needs no polling and no second channel: subscribe to the bus, refresh on
 * anything relevant, and unsubscribe when the screen's own `AbortSignal`
 * fires. Popping the screen is what stops it — there is no lifecycle to get
 * wrong, which is why every screen that wants this uses this one function
 * rather than its own three lines.
 *
 * A burst — a push that closes four issues — is coalesced into one refresh:
 * the outbox has no ordering guarantee a screen could use anyway, and four
 * reloads in a frame is four times the git for the same picture.
 */
export function live(
  f: Session,
  signal: AbortSignal,
  o: LiveOptions,
  refresh: () => void | Promise<void>,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = f.app.bus.subscribe((event) => {
    if (o.repoId !== undefined && event.repoId !== o.repoId) return;
    if (o.kinds !== undefined && !o.kinds.includes(event.kind)) return;
    if (o.where !== undefined && !o.where(event)) return;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (signal.aborted) return;
      // A refresh that throws at once (the forge closed under it) fails as
      // quietly as one that rejects, never as an uncaught error on the timer.
      void Promise.resolve().then(refresh).catch(() => undefined);
    }, LIVE_COALESCE_MS);
  });
  signal.addEventListener("abort", () => {
    off();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  });
}

// ---- links ----

/**
 * `O` / `o` on a URL.
 *
 * There is no control sequence that means "open this in the reader's browser"
 * — OSC 8 marks text clickable and the *user* clicks — so a session over SSH
 * cannot open anything, and that is the normal case, not the exception. The
 * old answer was "no browser available", which was true and useless. This one
 * does the two things that actually work: put the URL on the reader's own
 * clipboard through their terminal (OSC 52), and say so in words that name the
 * gesture. The URL is on screen as a hyperlink besides.
 *
 * Whether OSC 52 lands is the far-side terminal's decision and there is no
 * reply to read, which is why the toast says what was sent, never that it
 * arrived.
 */
export function openLink(ctx: Ctx, url: string): void {
  if (ctx.openUrl(url)) {
    ctx.toast("opening in your browser", "success");
    return;
  }
  // The browser is on the far side of the connection. Copy through the
  // terminal (OSC 52, for the terminals that honour it) and show the link
  // where it can be selected the ordinary way, mouse reporting off.
  ctx.copy(url);
  ctx.push(linkScreen(ctx, url));
}

/**
 * A page the web owns, from the terminal: the address, opened in a browser
 * when one is reachable and shown to copy when not. With no public URL
 * configured the path is still the answer, said as one. Settings, a run's
 * log, anything the terminal does not draw itself comes through here.
 */
export function openOnWeb(
  f: { app: { config: { url?: string | undefined } } },
  ctx: Ctx,
  path: string,
  what: string,
): void {
  const base = f.app.config.url;
  if (base === undefined) {
    ctx.toast(`${what} is on the web at ${path}`, "attn");
    return;
  }
  openLink(ctx, `${base.replace(/\/+$/, "")}${path}`);
}

/**
 * A link, shown plain so it can be selected and copied by hand, with mouse
 * reporting off for as long as it is open — the one thing that makes the
 * terminal's own drag-to-select work inside a mouse-aware app. `c` copies
 * through OSC 52 as well; `enter` opens a browser when one is reachable.
 */
export function linkScreen(
  ctx: Ctx,
  url: string,
  parent?: Screen,
  opts: { qr?: boolean } = {},
): Screen {
  ctx.mouse(false);
  // Encoded once, here, from exactly the link shown; held in this closure
  // only — never logged, never written anywhere. Render only draws it, so a
  // resize redraws the same cells and prints nothing twice.
  const code = opts.qr === true ? terminalQr(url) : undefined;
  return {
    title: "Link",
    keys: [
      binding(["c"], "copy"),
      binding(["enter"], "open"),
      binding(["esc", "q"], "close"),
    ],
    load(signal) {
      // Popping is what turns the mouse back on: nothing else has to remember.
      signal.addEventListener("abort", () => ctx.mouse(true), { once: true });
      return Promise.resolve();
    },
    render(area, s) {
      parent?.render(area, s);
      const text = [
        url,
        "",
        "Select the address to copy it: the mouse is yours here.",
        "c copies through the terminal too, when it allows it.",
      ];
      // The QR goes between the link and the help, only when the whole code
      // fits inside the dialog; otherwise the link alone, as before.
      const size = code === undefined ? undefined : qrSize(code);
      const width = Math.max(54, size === undefined ? 0 : size.cols + 4, [...url].length + 4);
      const room =
        size !== undefined &&
        width <= area.w - 4 &&
        text.length + 1 + size.rows + DIALOG_CHROME_ROWS <= area.h - 2;
      // Two lines (the link, a blank) come first; the QR takes the blank
      // rows reserved for it, its origin given by the dialog's own body rect.
      const body = room
        ? [url, "", ...new Array<string>(size.rows).fill(""), "", ...text.slice(2)]
        : text;
      dialog(s, area, ctx.theme.c, {
        title: "Link",
        body,
        actions: [{ label: "Copy" }, { label: "Close" }],
        selected: 0,
        width,
        ...(room && code !== undefined
          ? { paint: (b: Rect) => void drawQr(s, { x: b.x, y: b.y + 2, w: b.w, h: size.rows }, code) }
          : {}),
      });
    },
    key(e) {
      if (e.key === "c") {
        ctx.copy(url);
        ctx.toast("copied through the terminal", "success");
        return true;
      }
      if (e.key === "enter") {
        if (ctx.openUrl(url)) ctx.toast("opening in your browser", "success");
        else
          ctx.toast(
            "no browser on this side of the connection — copy it instead",
            "attn",
          );
        return true;
      }
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

/** A branch-safe slug of a path: `src/main.ts` → `src-main-ts`. */
export function slug(path: string): string {
  return (
    path
      .replace(/[^A-Za-z0-9._/-]+/g, "-")
      .replace(/[/.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "file"
  );
}

// ---- errors and time ----

const MESSAGES: Record<string, string> = {
  archived: ARCHIVED_WHY,
  not_member: NOT_A_MEMBER,
  not_found: "not found",
  signup_closed: SIGNUP_CLOSED_MESSAGE,
  human_check: "we could not tell you are a person; sign up on the web page",
  passkey_required: "new accounts sign up with a passkey and an email address: open the sign-up page in a browser",
  unauthorized: "sign in first",
  forbidden: "you do not have permission",
  forbidden_owner: "you cannot create repos for that owner",
  refused: NEW_ACCOUNT_GUARD_MESSAGE,
  empty_title: "a title is required",
  empty_body: "write something first",
  title_too_long: "that title is too long (256 characters at most)",
  body_too_long: "that text is too long (64 KB at most)",
  invalid_name: "that name is not allowed",
  invalid_username: "that username is not allowed",
  invalid_email: "that email address is not valid",
  invalid_key: "that is not a valid public key",
  invalid: "that is not valid",
  name_taken: "that name is taken",
  username_taken: "that username is taken",
  email_taken: "that email address is taken",
  key_exists: "that key is already registered",
  taken: "that name is taken",
  weak_password: "the password is too short (10 characters at least)",
  password_too_long: PASSWORD_TOO_LONG.toLowerCase().replace(/\.$/, ""),
  bad_credentials: "wrong username or password",
  throttled: "too many attempts: try again in a minute",
  already_forked: "you already have a fork of this repo",
  already_merged: "this pull is already merged",
  reason_required: "a bug closed without a fix says why: close it from the page or the API with a note",
  invalid_note: "a reason is one sentence of at most 300 characters",
  unknown_label: "no such label",
  unknown_branch: "no such branch",
  unknown_base: "the base branch does not exist",
  unknown_head: "the head branch does not exist",
  same_branch: "the base and head branches are the same",
  nothing_to_merge: "there is nothing to merge",
  invalid_branch: "that branch name is not allowed",
  conflict: "the branches conflict",
  closed: "this pull is closed",
  no_such_user: "no such user",
  protected: "that cannot be deleted",
  delete_failed: "the delete could not be completed",
  git_init_failed: "git could not create the repository",
  fork_failed: "the fork could not be created",
  bad_anchor: "that line is not part of this diff",
  invalid_url: "that URL is not valid (a git:// address is not supported: use its https:// address)",
  // Reviews. `review_required` is the merge gate refusing, and it is the one
  // refusal a reviewer can act on, so it names the act rather than the rule.
  review_required: "this needs an approval of its current head first",
  self_review: "you cannot approve your own change",
  invalid_state: "that is not a review verdict",
  looks_required: "a stylesheet change waits for its home-page looks at phone and desktop width",
  // The fork flow. Each of these leaves the world in a different place, so
  // each keeps its own sentence.
  fork_timeout: "the origin took the fork and it never appeared — try again",
  mirror_failed: "the fork was made, but the copy here failed",
  empty_files: "there is nothing to propose",
  invalid_token: "that token is not valid",
  // Origins. Three of these mean nothing changed anywhere and the fourth
  // means the change belongs on another forge — a single "that failed"
  // would hide which, so each keeps its own sentence.
  mirrored: "this repo mirrors an origin — do it there",
  origin_owner_only: "only whoever connected this origin can write through it",
  origin_refused: "the origin refused that; nothing changed here",
  origin_read_only: "this account was connected read-only; nothing is written through it",
  origin_paused: "this connection is not verified yet; writes are paused",
  origin_protected: "the operator protects this repository at its origin: nothing is pushed to it from here; propose the change from your fork",
  origin_unreachable: "the origin could not be reached; nothing changed",
  already_connected: ORIGIN_ALREADY_CONNECTED,
  already_mirrored: "that repository is already mirrored here",
  unknown_host: "that does not look like a forge",
  private_host: PRIVATE_ADDRESS_REFUSED,
  unreachable: "that instance could not be reached",
  bad_token: "the origin refused that token",
  rate_limited: "too many connect attempts; wait a few minutes",
  no_app: "register an OAuth application on that instance first",
  provider_refused: "the origin refused to start that connect",
  // Apps, runs and the crew (docs/APPS.md). `checks_required` is the merge
  // gate refusing, so like `review_required` it names what to do about it.
  checks_required: "this needs a passing deploy of its current head first",
  invalid_slug: "a slug is lowercase letters, digits and single hyphens",
  slug_taken: "that slug is taken by another app",
  already_app: "this repository is already an app",
  no_runtime: "apps are off on this forge (FORGE_APPS=0)",
  no_such_env: "no such environment",
  nothing_to_deploy: "there is nothing to deploy — the branch is empty",
  finished: "that run has already finished",
  no_such_agent: "no such agent",
  scaffold_failed: "the repository was made, but the app could not be started",
  assignee_cannot_read: "they cannot see this repository",
  agent_not_on_crew: AGENT_NOT_ON_CREW,
  invalid_model: "that model name is not valid",
  brief_too_long: "that brief is too long (4000 characters at most)",
  invalid_budget: "the budget must be between 0 and 100 dollars",
};

/**
 * The glyphs provenance and pinning wear, from the safe set in `term/screen`.
 * `\u25b2` means "this came from the origin" (upstream); `\u25c6` means "kept on
 * this machine". Both are documented in `docs/DESIGN.md`.
 */
export const ORIGIN_MARK = "\u25b2";
export const PIN_MARK = "\u25c6";

/**
 * The verdict a pull row wears, from the same safe set: `\u2713` approved,
 * `\u2717` changes requested, `\u00b7` nobody has looked yet. One column, tabular,
 * so a queue of pulls reads as a column of marks rather than a ragged edge —
 * and the "nobody has looked" mark is a dot on purpose, because an unreviewed
 * pull is a quiet fact, not a warning.
 */
export const VERDICT_MARKS = {
  approved: "\u2713",
  changes_requested: "\u2717",
  none: "\u00b7",
} as const;

/**
 * The counts every repo row wears: open issues and open pulls, then comments
 * on a conversation row. Three glyphs, documented in `docs/DESIGN.md`, from
 * the same safe set as everything else.
 */
export const ISSUE_MARK = G.ring;
export const PULL_MARK = G.pull;
export const COMMENT_MARK = G.comment;

/**
 * A formatter for a whole list's counts, so the numbers line up as a column
 * instead of jittering row to row. Zero is *absent*, not `\u25cb 0` \u2014 an empty
 * queue should read as quiet, and a column of zeroes reads as noise.
 *
 * Take the counts from `countsForRepos` / `withCounts`, never from a query per
 * row: a list is exactly where N+1 hurts most, and `test/counts.test.ts`
 * exists to keep it that way.
 */
export function countsColumn(
  all: readonly (RepoCounts | undefined)[],
  set: IconSet = "plain",
): (counts: RepoCounts | undefined) => string {
  const issueMark = icon("issue", set);
  const pullMark = icon("pull", set);
  const width = (pick: (c: RepoCounts) => number): number =>
    all.reduce(
      (max, c) =>
        c === undefined || pick(c) === 0
          ? max
          : Math.max(max, String(pick(c)).length),
      0,
    );
  const issueW = width((c) => c.openIssues);
  const pullW = width((c) => c.openPulls);
  return (counts) => {
    if (counts === undefined) return "";
    if (counts.openIssues === 0 && counts.openPulls === 0) return "";
    const issues =
      issueW === 0
        ? ""
        : counts.openIssues === 0
          ? " ".repeat(issueW + 2)
          : `${issueMark} ${pad(String(counts.openIssues), issueW, "right")}`;
    const pulls =
      pullW === 0
        ? ""
        : counts.openPulls === 0
          ? " ".repeat(pullW + 2)
          : `${pullMark} ${pad(String(counts.openPulls), pullW, "right")}`;
    return `${issues}${issues !== "" && pulls !== "" ? "  " : ""}${pulls}`.trimEnd();
  };
}

/** `\u25ad 4` on a conversation row; nothing at all when nobody has replied. */
export function commentsMeta(count: number, set: IconSet = "plain"): string {
  return count > 0 ? `${icon("comment", set)} ${count}` : "";
}

/** Join a row's meta pieces, dropping the empty ones. */
export function metaOf(...parts: readonly string[]): string {
  return parts.filter((p) => p !== "").join("  ");
}

/** A stable error code, as a sentence. Unknown codes are shown verbatim. */
export function errorText(code: string): string {
  return MESSAGES[code] ?? code.replace(/_/g, " ");
}

/** Anything thrown, as a string — the toast text of last resort. */
export function message(error: unknown): string {
  const refused = refusalText(error);
  if (refused !== undefined) return refused;
  return error instanceof Error ? error.message : String(error);
}

/** Fire an async action; any throw becomes a toast rather than a dead screen. */
export function runAsync(ctx: Ctx, fn: () => Promise<unknown>): void {
  void ctx
    .track(fn())
    .catch((error: unknown) => ctx.toast(message(error), "danger"));
}

const UNITS: readonly (readonly [number, string])[] = [
  [31_536_000, "y"],
  [2_592_000, "mo"],
  [604_800, "w"],
  [86_400, "d"],
  [3_600, "h"],
  [60, "m"],
];

/** Compact relative time: "3d", "2h", "just now". */
export function relTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  for (const [size, suffix] of UNITS)
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix}`;
  return "now";
}

/** The same clock as a sentence: "2m ago", "just now". */
export function ago(iso: string): string {
  const rel = relTime(iso);
  if (rel === "") return "";
  return rel === "now" ? "just now" : `${rel} ago`;
}

export { plural } from "../../kernel/plural.ts";

/** A screen that draws nothing — the parent a palette-launched modal has. */
export function blank(title: string): Screen {
  return { title, keys: [], render: () => undefined, key: () => false };
}
