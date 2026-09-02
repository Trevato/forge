/**
 * The vocabulary every forge screen shares: a list cursor, a scroll offset, a
 * filter-as-you-type box, three modal screens, and the one place a `Result`
 * error code becomes a sentence a person can read.
 *
 * Screens stay short because these carry the parts that are identical in all
 * of them. Nothing here knows about repos or issues — that is the point.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import { Screen as Surface, type Rect } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Tokens } from "../ui/theme.ts";
import {
  card,
  dialog,
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
  readonly secondary?: string;
  readonly meta?: string;
}

/** A scrolling list of `row()`s with a scrollbar when it overflows. */
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
  const from = state.window(r.h, rows.length);
  for (let i = 0; i < r.h; i++) {
    const item = rows[from + i];
    if (item === undefined) break;
    row(s, { x: body.x, y: body.y + i, w: body.w, h: 1 }, c, {
      ...item,
      selected: focused && from + i === state.index,
      focused: from + i === state.index,
    });
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total: rows.length,
    offset: from,
  });
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

/** A label/value column — the "about" blocks every detail screen carries. */
export function drawFacts(
  s: Surface,
  r: Rect,
  c: Tokens,
  facts: readonly (readonly [string, string])[],
): void {
  facts.forEach(([label, value], i) => {
    if (i >= r.h) return;
    const y = r.y + i;
    s.text(r.x, y, truncate(label, 14), style(c.mutedFg, c.bg), r.x + r.w);
    s.text(
      r.x + 15,
      y,
      truncate(value, Math.max(0, r.w - 15)),
      style(c.fg, c.bg),
      r.x + r.w,
    );
  });
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
      dialog(s, area, ctx.theme.c, {
        title: o.title,
        body: o.body,
        actions: o.actions,
        selected,
      });
    },
    key(e) {
      if (e.key === "left" || e.key === "h")
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
      const cursor = input(s, { x, y: y + 1, w: w - 4, h: 1 }, c, {
        value,
        cursor: [...value].length,
        focused: true,
        ...(o.placeholder === undefined ? {} : { placeholder: o.placeholder }),
        ...(error === undefined ? {} : { invalid: true }),
      });
      ctx.setCursor(cursor);
    },
    paste(text) {
      value += text.replace(/\s+/g, " ");
      return true;
    },
    key(e) {
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.key === "enter") {
        const outcome = o.onSubmit(value.trim());
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

// ---- errors and time ----

const MESSAGES: Record<string, string> = {
  not_found: "not found",
  unauthorized: "sign in first",
  forbidden: "you do not have permission",
  forbidden_owner: "you cannot create repos for that owner",
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
  weak_password: "the password must be at least 10 characters",
  bad_credentials: "wrong username or password",
  already_forked: "you already have a fork of this repo",
  already_merged: "this pull is already merged",
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
  invalid_url: "that URL is not valid",
  invalid_token: "that token is not valid",
};

/** A stable error code, as a sentence. Unknown codes are shown verbatim. */
export function errorText(code: string): string {
  return MESSAGES[code] ?? code.replace(/_/g, " ");
}

/** Anything thrown, as a string — the toast text of last resort. */
export function message(error: unknown): string {
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

/**
 * "1 comment", "0 comments". A count and its noun are one phrase, so they are
 * formatted in one place — the alternative is `1 commits` in whichever screen
 * was written last, which is precisely what happened before this existed.
 */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
