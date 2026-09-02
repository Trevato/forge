/**
 * Bytes → events, as a pure incremental parser (vaxis's contract).
 *
 * `parse(buf, off, final)` returns `{ event, n }` where **`n === 0` means
 * "need more bytes, consumed nothing"**. No half-parsed state ever lives
 * inside the parser, so a sequence split across chunk boundaries is a
 * non-event — and chunk boundaries are the entire problem over SSH, where
 * channel data arrives in arbitrary splits (a two-byte "é" really does show
 * up as two reads).
 *
 * `final = true` means "no more bytes are coming right now" — the caller's
 * idle timer. It is the only thing that distinguishes a bare Escape from the
 * start of an Alt+key or a CSI, because the byte streams are identical and
 * only arrival grouping tells them apart.
 */

export interface KeyEvent {
  readonly type: "key";
  /** "a", "enter", "tab", "esc", "up", "pgdn", "f5", … */
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface PasteEvent {
  readonly type: "paste";
  readonly text: string;
}

/** Wheel only — motion tracking floods an SSH channel and buys us nothing. */
export interface MouseEvent {
  readonly type: "mouse";
  readonly kind: "wheel-up" | "wheel-down";
  readonly x: number;
  readonly y: number;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface ResizeEvent {
  readonly type: "resize";
  readonly cols: number;
  readonly rows: number;
}

export type InputEvent = KeyEvent | PasteEvent | MouseEvent | ResizeEvent;

export interface ParseResult {
  readonly event: InputEvent | null;
  /** Bytes consumed. 0 = need more; >0 with a null event = consumed silently. */
  readonly n: number;
}

const NEED_MORE: ParseResult = { event: null, n: 0 };

function key(
  name: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyEvent {
  return {
    type: "key",
    key: name,
    ctrl: mods.ctrl ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false,
  };
}

// CSI/SS3 letter finals, and the tilde-number keypad. Both forms are accepted
// unconditionally: arrows are DECCKM-dependent and we do not control which
// mode we inherit — shells and readline flip it behind our back.
const LETTER: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const TILDE: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pgup",
  6: "pgdn",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/** `mod` is 1 + bitmask, bitmask = shift 1 | alt 2 | ctrl 4 | meta 8. */
function mods(mod: number | undefined): {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
} {
  const bits = mod === undefined || mod < 1 ? 0 : mod - 1;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

const decoder = new TextDecoder();

function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc0 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf7) return 4;
  return -1; // a continuation byte or 0xF8+ as a lead: malformed
}

export function parse(
  buf: Uint8Array,
  off: number,
  final: boolean,
): ParseResult {
  const b = buf[off];
  if (b === undefined) return NEED_MORE;
  if (b === 0x1b) return parseEscape(buf, off, final);
  return parsePlain(buf, off, final);
}

function parsePlain(buf: Uint8Array, off: number, final: boolean): ParseResult {
  const b = buf[off]!;
  // Raw mode clears ICRNL, so Enter arrives as CR. Accept LF too: tmux, some
  // clients and pasted text send it, and Ctrl+J is not worth the ambiguity.
  if (b === 0x0d || b === 0x0a) return { event: key("enter"), n: 1 };
  if (b === 0x09) return { event: key("tab"), n: 1 };
  // 0x08 as well as 0x7f: older emulators and `stty erase ^H` send BS.
  if (b === 0x7f || b === 0x08) return { event: key("backspace"), n: 1 };
  if (b === 0x00) return { event: key("space", { ctrl: true }), n: 1 };
  if (b >= 0x01 && b <= 0x1a)
    return { event: key(String.fromCharCode(b + 96), { ctrl: true }), n: 1 };
  if (b >= 0x1c && b <= 0x1f)
    return { event: key(String.fromCharCode(b + 64), { ctrl: true }), n: 1 };

  const len = utf8Length(b);
  if (len === -1) return { event: null, n: 1 }; // resync, never clear the buffer
  if (off + len > buf.length) {
    // Not enough continuation bytes yet. This is "need more", not an error —
    // the rest of the character is in the next chunk.
    return final ? { event: null, n: 1 } : NEED_MORE;
  }
  const text = decoder.decode(buf.subarray(off, off + len));
  return { event: key(text), n: len };
}

function parseEscape(
  buf: Uint8Array,
  off: number,
  final: boolean,
): ParseResult {
  const next = buf[off + 1];
  if (next === undefined) {
    // A bare trailing ESC could still become Alt+key or a CSI. Only the
    // caller's idle timer (final) can settle it.
    return final ? { event: key("esc"), n: 1 } : NEED_MORE;
  }
  if (next === 0x5b) return parseCsi(buf, off, final); // '['
  if (next === 0x4f) return parseSs3(buf, off, final); // 'O'
  if (next === 0x1b) return { event: key("esc"), n: 1 }; // ESC ESC → Esc, retry

  // ESC + anything else is Alt+that. Reuse the plain parser so Alt+Enter,
  // Alt+Backspace and multi-byte Alt+é all fall out for free.
  const inner = parse(buf, off + 1, final);
  if (inner.n === 0) return NEED_MORE;
  if (inner.event === null || inner.event.type !== "key")
    return { event: null, n: inner.n + 1 };
  return {
    event: { ...inner.event, alt: true },
    n: inner.n + 1,
  };
}

function parseSs3(buf: Uint8Array, off: number, final: boolean): ParseResult {
  const f = buf[off + 2];
  if (f === undefined) return final ? { event: null, n: 2 } : NEED_MORE;
  const name = LETTER[String.fromCharCode(f)];
  return name === undefined
    ? { event: null, n: 3 }
    : { event: key(name), n: 3 };
}

const PASTE_START = "200";
const PASTE_END = "\x1b[201~";

function parseCsi(buf: Uint8Array, off: number, final: boolean): ParseResult {
  let i = off + 2;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c >= 0x40 && c <= 0x7e) break; // final byte
    if (c < 0x20 || c > 0x3f) {
      // A control byte inside a CSI means the sequence was malformed. Resync
      // on it rather than clearing the buffer (crossterm's documented bug).
      return { event: null, n: i - off };
    }
    i++;
  }
  if (i >= buf.length)
    return final ? { event: null, n: buf.length - off } : NEED_MORE;

  const fin = String.fromCharCode(buf[i]!);
  const body = String.fromCharCode(...buf.subarray(off + 2, i));
  const n = i - off + 1;

  if (body === PASTE_START && fin === "~") return parsePaste(buf, off, final);
  if (body.startsWith("<")) return parseMouse(body.slice(1), fin, n);
  if (fin === "Z") return { event: key("tab", { shift: true }), n };
  // Focus in/out (mode 1004). We never enable it, but tmux or a wrapper may;
  // recognise and drop it rather than injecting a phantom keystroke.
  if (body === "" && (fin === "I" || fin === "O")) return { event: null, n };

  const params = body === "" ? [] : body.split(";").map((p) => Number(p) || 0);
  if (fin === "~") {
    const name = TILDE[params[0] ?? 0];
    return name === undefined
      ? { event: null, n }
      : { event: key(name, mods(params[1])), n };
  }
  const name = LETTER[fin];
  if (name === undefined) return { event: null, n };
  // `CSI 1;5A` — the leading 1 is a placeholder; the modifier is the second
  // parameter. Note F1–F4 switch from SS3 to CSI once modified.
  return { event: key(name, mods(params[1])), n };
}

/**
 * Bracketed paste. The payload is opaque data, never key events: a hostile
 * clipboard can embed its own `ESC[201~` to "end" the paste early and have
 * the following bytes run as genuine keystrokes. We take the *first* end
 * marker, then strip ESC and every C0 except tab and newline from the text.
 */
function parsePaste(buf: Uint8Array, off: number, final: boolean): ParseResult {
  const start = off + 6; // ESC [ 2 0 0 ~
  const text = decoder.decode(buf.subarray(start));
  const end = text.indexOf(PASTE_END);
  if (end === -1) {
    if (!final) return NEED_MORE;
    return {
      event: { type: "paste", text: sanitize(text) },
      n: buf.length - off,
    };
  }
  const payload = text.slice(0, end);
  const consumed =
    6 + new TextEncoder().encode(payload).length + PASTE_END.length;
  return { event: { type: "paste", text: sanitize(payload) }, n: consumed };
}

function sanitize(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a) out += ch;
    else if (cp < 0x20 || cp === 0x7f) continue;
    else out += ch;
  }
  return out;
}

/** SGR mouse (1006): `ESC[<btn;col;rowM` press, `…m` release, 1-based. */
function parseMouse(body: string, fin: string, n: number): ParseResult {
  if (fin !== "M" && fin !== "m") return { event: null, n };
  const parts = body.split(";").map((p) => Number(p) || 0);
  const btn = parts[0] ?? 0;
  // +64 is the wheel bit; 64 = up, 65 = down. Everything else (clicks, drag)
  // is consumed and dropped — this is a keyboard-driven forge.
  if ((btn & 64) === 0 || fin === "m") return { event: null, n };
  const which = btn & 3;
  if (which > 1) return { event: null, n };
  return {
    event: {
      type: "mouse",
      kind: which === 0 ? "wheel-up" : "wheel-down",
      x: Math.max(0, (parts[1] ?? 1) - 1),
      y: Math.max(0, (parts[2] ?? 1) - 1),
      shift: (btn & 4) !== 0,
      alt: (btn & 8) !== 0,
      ctrl: (btn & 16) !== 0,
    },
    n,
  };
}

/**
 * Owns the byte buffer so the parser doesn't have to. `push` drains whatever
 * is unambiguous; `flush` is the idle timer firing, which settles a trailing
 * ESC and any sequence truncated by a disconnect.
 */
export class InputDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): InputEvent[] {
    if (this.buf.length === 0) this.buf = chunk.slice();
    else {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    }
    return this.drain(false);
  }

  flush(): InputEvent[] {
    return this.drain(true);
  }

  get pending(): number {
    return this.buf.length;
  }

  private drain(final: boolean): InputEvent[] {
    const events: InputEvent[] = [];
    let off = 0;
    while (off < this.buf.length) {
      const r = parse(this.buf, off, final);
      if (r.n === 0) break;
      if (r.event !== null) events.push(r.event);
      off += r.n;
    }
    this.buf = off === 0 ? this.buf : this.buf.subarray(off).slice();
    return events;
  }
}
