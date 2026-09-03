/**
 * The escape sequences we emit, in one place, plus the single tokenizer that
 * splits a string into complete escape sequences and literal text.
 *
 * One tokenizer serves width, wrap, truncate and strip alike (wrap-ansi v10's
 * design). The rule that matters: a lone ESC that does not begin a *complete*
 * sequence is literal text, never a silently swallowed byte. Counting bytes
 * with a naive `/\x1b\[[0-9;]*m/` regex mishandles OSC 8 hyperlinks and every
 * non-SGR CSI, which is how width bugs start.
 */

export const ESC = "\x1b";
export const CSI = "\x1b[";
export const SS3 = "\x1bO";
export const ST = "\x1b\\";
export const BEL = "\x07";

// Screen and cursor.
export const ALT_ENTER = "\x1b[?1049h";
export const ALT_LEAVE = "\x1b[?1049l";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
export const ERASE_ALL = "\x1b[2J";
export const ERASE_LINE_RIGHT = "\x1b[0K";
export const WRAP_OFF = "\x1b[?7l";
export const WRAP_ON = "\x1b[?7h";
export const SGR_RESET = "\x1b[0m";

/**
 * DEC private mode 2026, "synchronized output": the terminal buffers every
 * byte between BSU and ESU and paints once. This is what removes tearing when
 * a frame's diff crosses many rows. Terminals that don't implement it ignore
 * an unknown private mode, so we emit it unconditionally rather than probing
 * (DECRQM would only tell us something we can't act on).
 */
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

// Input modes. Enable order matters for the mouse: SGR coordinates (1006)
// last, so the encoding is in place before any event can flow; disable in the
// exact reverse.
export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";
/**
 * Button reporting (1000), button-event tracking (1002), SGR coordinates
 * (1006). 1002 adds motion-while-pressed: nothing in the forge tracks a drag
 * and the parser drops motion reports, but without it a press-drag-release
 * loses its release, and a terminal that believes a button is still down
 * behaves oddly for the rest of the session.
 */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l";
export const FOCUS_OFF = "\x1b[?1004l";

/**
 * OSC 8 hyperlinks. `ESC ] 8 ; <params> ; <uri> BEL` opens, the same with an
 * empty URI closes. BEL rather than ST because that is what this file already
 * emits for OSC 52 and every terminal in the support matrix accepts both.
 *
 * `id=` is always sent: cells sharing a URI *and* a non-empty id are one link
 * for hover purposes, which is what keeps a link painted as several disjoint
 * dirty runs from underlining as several links.
 */
export const OSC8_CLOSE = "\x1b]8;;\x07";

export function osc8Open(uri: string, id: number): string {
  return `\x1b]8;id=f${id};${uri}\x07`;
}

/** Reset the cursor shape. nvim leaves a steady block behind on exit. */
export const CURSOR_SHAPE_RESET = "\x1b[0 q";
/** Pop any kitty keyboard-protocol flags a suspended child pushed. */
export const KITTY_KEYS_POP = "\x1b[>0u";

/** Cursor position. Terminal coordinates are 1-based; ours are 0-based. */
export function cup(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

export type Chunk =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "seq"; readonly text: string };

const isFinal = (c: number): boolean => c >= 0x40 && c <= 0x7e;

/**
 * Split into literal text and complete escape sequences. Returns the sequence
 * boundaries so callers never measure, cut, or pad in the middle of one.
 */
export function tokenize(input: string): Chunk[] {
  const out: Chunk[] = [];
  let text = "";
  let i = 0;
  const push = (): void => {
    if (text !== "") out.push({ kind: "text", text });
    text = "";
  };
  while (i < input.length) {
    if (input[i] !== ESC) {
      text += input[i];
      i++;
      continue;
    }
    const end = sequenceEnd(input, i);
    if (end === -1) {
      // Not a complete sequence — by the wrap-ansi rule it is literal text.
      text += input[i];
      i++;
      continue;
    }
    push();
    out.push({ kind: "seq", text: input.slice(i, end) });
    i = end;
  }
  push();
  return out;
}

/** Index one past a complete sequence starting at `i`, or -1 if incomplete. */
function sequenceEnd(s: string, i: number): number {
  const next = s[i + 1];
  if (next === undefined) return -1;
  if (next === "[") {
    let j = i + 2;
    while (j < s.length && !isFinal(s.charCodeAt(j))) j++;
    return j < s.length ? j + 1 : -1;
  }
  if (next === "]") {
    // OSC runs until BEL or ST; accept either terminator regardless of which
    // the sender used (terminals are inconsistent here — see termenv#25).
    let j = i + 2;
    while (j < s.length) {
      if (s[j] === BEL) return j + 1;
      if (s[j] === ESC && s[j + 1] === "\\") return j + 2;
      j++;
    }
    return -1;
  }
  if (next === "O") return i + 3 <= s.length ? i + 3 : -1;
  // Two-byte escapes, but only the ones that really exist: DECSC/DECRC, the
  // keypad modes, ST, and the C1 equivalents (ESC @ … ESC _). Anything else
  // after an ESC is literal text, so `stripAnsi("a\x1bb")` keeps the b.
  const code = next.charCodeAt(0);
  const twoByte =
    next === "7" ||
    next === "8" ||
    next === "=" ||
    next === ">" ||
    (code >= 0x40 && code <= 0x5f);
  return twoByte ? i + 2 : -1;
}

/** Drop every escape sequence, keeping literal text intact. */
export function stripAnsi(input: string): string {
  if (!input.includes(ESC)) return input;
  let out = "";
  for (const c of tokenize(input)) if (c.kind === "text") out += c.text;
  return out;
}
