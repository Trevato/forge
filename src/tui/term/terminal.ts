/**
 * The transport boundary. Everything above this line is pure: a `Screen` in,
 * bytes out, bytes in, events out. Nothing else in the TUI touches `process`,
 * which is what lets the same runtime serve a local stdio session, an
 * in-process SSH channel, and a test harness without a branch anywhere.
 */

import {
  ALT_ENTER,
  ALT_LEAVE,
  CURSOR_SHOW,
  ERASE_ALL,
  FOCUS_OFF,
  MOUSE_OFF,
  MOUSE_ON,
  PASTE_OFF,
  PASTE_ON,
  SGR_RESET,
  CURSOR_HIDE,
  WRAP_OFF,
  WRAP_ON,
} from "./ansi.ts";
import { Screen, TRAIL } from "./screen.ts";
import { DEFAULT, PLAIN, type Style } from "./style.ts";
import { clusters } from "./width.ts";

export interface Terminal {
  write(bytes: Uint8Array): void;
  onInput(cb: (chunk: Uint8Array) => void): void;
  size(): { cols: number; rows: number };
  onResize(cb: (cols: number, rows: number) => void): void;
  onClose(cb: () => void): void;
  /** Release the transport (raw mode, the channel). Idempotent. */
  close(): void;
  /** The `TERM` the client announced; the only env var SSH forwards. */
  readonly term?: string;
}

const encoder = new TextEncoder();

export interface SessionOpts {
  /**
   * Mouse reporting is OFF by default and opt-in: enabling it breaks the
   * terminal's native text selection, which is the single most common
   * complaint about mouse-enabled TUIs. Shift overrides it in every terminal
   * that matters, but users do not know that, so we advertise it in help.
   */
  readonly mouse?: boolean;
  /** Install process-level exit hooks (stdio only; never for a test/SSH). */
  readonly exitHooks?: boolean;
}

/**
 * Enter/leave, with cleanup guaranteed on every exit path. A TUI that leaves
 * a terminal broken is unforgivable, so `leave()` is idempotent and wired to
 * normal return, signals, uncaught throws and rejections alike.
 *
 * Two rules in the leave order carry all the weight: SGR reset happens
 * *before* leaving the alt screen (otherwise attributes leak into the primary
 * buffer and corrupt the user's shell prompt), and the transport is released
 * last (we are still emitting sequences that depend on raw mode until then).
 */
export class TerminalSession {
  private entered = false;
  private left = false;
  private detach: (() => void)[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly opts: SessionOpts = {},
  ) {}

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.send(
      ALT_ENTER +
        WRAP_OFF +
        CURSOR_HIDE +
        ERASE_ALL +
        PASTE_ON +
        (this.opts.mouse ? MOUSE_ON : ""),
    );
    if (this.opts.exitHooks) this.installHooks();
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    this.send(
      SGR_RESET +
        PASTE_OFF +
        MOUSE_OFF +
        FOCUS_OFF +
        CURSOR_SHOW +
        WRAP_ON +
        ALT_LEAVE,
    );
    for (const off of this.detach) off();
    this.detach = [];
    this.term.close();
  }

  /** Anything printed outside the frame loop needs CRLF: raw mode has ONLCR off. */
  print(line: string): void {
    this.send(line.replace(/\r?\n/g, "\r\n"));
  }

  private send(s: string): void {
    this.term.write(encoder.encode(s));
  }

  private installHooks(): void {
    const bye = (): void => this.leave();
    const fatal = (e: unknown): void => {
      this.leave();
      // The terminal is restored; now let the error be seen normally.
      console.error(e);
      process.exit(1);
    };
    const on = <T extends string>(
      ev: T,
      fn: (...args: never[]) => void,
    ): void => {
      process.on(ev as never, fn as never);
      this.detach.push(() => process.off(ev as never, fn as never));
    };
    on("exit", bye);
    on("SIGINT", bye);
    on("SIGTERM", bye);
    on("SIGHUP", bye);
    on("uncaughtException", fatal);
    on("unhandledRejection", fatal);
  }
}

/** The local dev terminal. Sizes come from the tty, never assumed. */
export function stdioTerminal(): Terminal {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let closed = false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const term: Terminal = {
    write(bytes) {
      if (!closed) stdout.write(bytes);
    },
    onInput(cb) {
      stdin.on("data", (chunk: Buffer) => cb(new Uint8Array(chunk)));
    },
    size() {
      // `columns`/`rows` are undefined when stdout is not a tty — verified.
      return { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
    },
    onResize(cb) {
      process.on("SIGWINCH", () => {
        // A resize handler must never take the session down (wish learned
        // this the hard way with one client's panic killing the server).
        try {
          cb(stdout.columns ?? 80, stdout.rows ?? 24);
        } catch {
          /* ignore */
        }
      });
    },
    onClose(cb) {
      stdin.on("end", cb);
    },
    close() {
      if (closed) return;
      closed = true;
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    },
  };
  const name = process.env["TERM"];
  return name === undefined ? term : { ...term, term: name };
}

export interface HeadlessTerminal extends Terminal {
  /** Everything written, as one string. */
  output(): string;
  /** Bytes written since the last `takeOutput()`. */
  takeOutput(): string;
  /** Push input as if the user typed it. */
  feed(bytes: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  /** The grid our own ANSI produced — the renderer's self-check. */
  readonly screen: Screen;
  toText(): string;
  readonly closed: boolean;
}

/**
 * The test transport. It records what we wrote *and* replays it into a small
 * virtual terminal, so a test can assert the emitted bytes actually produce
 * the grid the `Screen` held. If the diff renderer emits a wrong cursor move,
 * the two grids diverge and the test catches it — which is worth far more
 * than substring-matching ANSI soup.
 */
export function headlessTerminal(cols = 80, rows = 24): HeadlessTerminal {
  let cursorCols = cols;
  let cursorRows = rows;
  let all = "";
  let since = "";
  let closed = false;
  let vt = new VirtualTerminal(cols, rows);
  const inputs: ((chunk: Uint8Array) => void)[] = [];
  const resizes: ((c: number, r: number) => void)[] = [];
  const closes: (() => void)[] = [];
  const dec = new TextDecoder();

  return {
    write(bytes) {
      const s = dec.decode(bytes);
      all += s;
      since += s;
      vt.consume(s);
    },
    onInput(cb) {
      inputs.push(cb);
    },
    size() {
      return { cols: cursorCols, rows: cursorRows };
    },
    onResize(cb) {
      resizes.push(cb);
    },
    onClose(cb) {
      closes.push(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const cb of closes) cb();
    },
    output: () => all,
    takeOutput() {
      const out = since;
      since = "";
      return out;
    },
    feed(bytes) {
      const chunk = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
      for (const cb of inputs) cb(chunk);
    },
    resize(c, r) {
      cursorCols = c;
      cursorRows = r;
      vt = new VirtualTerminal(c, r);
      for (const cb of resizes) cb(c, r);
    },
    get screen() {
      return vt.screen;
    },
    toText: () => vt.screen.toText(),
    get closed() {
      return closed;
    },
  };
}

/**
 * A terminal that understands exactly what our renderer emits — CUP, SGR, ED,
 * EL, private mode set/reset, and printable text. Deliberately not a general
 * emulator: its value is that it double-checks *us*.
 */
export class VirtualTerminal {
  readonly screen: Screen;
  private x = 0;
  private y = 0;
  private cur: Style = PLAIN;
  cursorVisible = true;
  syncDepth = 0;

  constructor(cols: number, rows: number) {
    this.screen = new Screen(cols, rows);
    this.screen.clear(PLAIN);
  }

  consume(input: string): void {
    let i = 0;
    while (i < input.length) {
      const c = input[i]!;
      if (c !== "\x1b") {
        i = this.print(input, i);
        continue;
      }
      if (input[i + 1] !== "[") {
        i += 2;
        continue;
      }
      let j = i + 2;
      while (
        j < input.length &&
        !(input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e)
      )
        j++;
      if (j >= input.length) return;
      this.csi(input.slice(i + 2, j), input[j]!);
      i = j + 1;
    }
  }

  private print(input: string, from: number): number {
    let i = from;
    let run = "";
    while (i < input.length && input[i] !== "\x1b") run += input[i++];
    for (const cluster of clusters(run)) {
      if (this.x >= this.screen.cols) break; // auto-wrap is off
      this.x += this.screen.set(this.x, this.y, cluster, this.cur);
    }
    return i;
  }

  private csi(body: string, fin: string): void {
    if (body.startsWith("?")) return; // private modes: sync, cursor, wrap
    const params =
      body === "" ? [] : body.split(";").map((p) => Number(p) || 0);
    switch (fin) {
      case "H": {
        this.y = Math.max(0, (params[0] ?? 1) - 1);
        this.x = Math.max(0, (params[1] ?? 1) - 1);
        return;
      }
      case "J": {
        if ((params[0] ?? 0) === 2) {
          this.screen.clear(PLAIN);
          this.x = 0;
          this.y = 0;
        }
        return;
      }
      case "K": {
        for (let x = this.x; x < this.screen.cols; x++)
          this.screen.set(x, this.y, " ", this.cur);
        return;
      }
      case "m":
        this.sgr(params);
        return;
      default:
        return;
    }
  }

  private sgr(params: number[]): void {
    if (params.length === 0) params = [0];
    let s = this.cur;
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      switch (p) {
        case 0:
          s = PLAIN;
          break;
        case 1:
          s = { ...s, attr: s.attr | 1 };
          break;
        case 2:
          s = { ...s, attr: s.attr | 2 };
          break;
        case 3:
          s = { ...s, attr: s.attr | 4 };
          break;
        case 4:
          s = { ...s, attr: s.attr | 8 };
          break;
        case 7:
          s = { ...s, attr: s.attr | 16 };
          break;
        case 9:
          s = { ...s, attr: s.attr | 32 };
          break;
        case 22:
          s = { ...s, attr: s.attr & ~3 };
          break;
        case 23:
          s = { ...s, attr: s.attr & ~4 };
          break;
        case 24:
          s = { ...s, attr: s.attr & ~8 };
          break;
        case 27:
          s = { ...s, attr: s.attr & ~16 };
          break;
        case 29:
          s = { ...s, attr: s.attr & ~32 };
          break;
        case 39:
          s = { ...s, fg: DEFAULT };
          break;
        case 49:
          s = { ...s, bg: DEFAULT };
          break;
        case 38:
        case 48: {
          const kind = params[i + 1];
          if (kind === 2) {
            const v =
              ((params[i + 2] ?? 0) << 16) |
              ((params[i + 3] ?? 0) << 8) |
              (params[i + 4] ?? 0);
            s = p === 38 ? { ...s, fg: v } : { ...s, bg: v };
            i += 4;
          } else if (kind === 5) {
            // Indexed colours are recorded as the index itself; a truecolor
            // session never emits them, and the quantizer is tested directly.
            const v = params[i + 2] ?? 0;
            s = p === 38 ? { ...s, fg: v } : { ...s, bg: v };
            i += 2;
          }
          break;
        }
        default:
          break;
      }
    }
    this.cur = s;
  }
}

/** Cell-by-cell comparison, with the annotation that makes a failure obvious. */
export function diffScreens(a: Screen, b: Screen): string | null {
  if (a.cols !== b.cols || a.rows !== b.rows)
    return `size ${a.cols}x${a.rows} vs ${b.cols}x${b.rows}`;
  for (let y = 0; y < a.rows; y++) {
    for (let x = 0; x < a.cols; x++) {
      const i = a.idx(x, y);
      if (a.glyph[i] === TRAIL && b.glyph[i] === TRAIL) continue;
      if (
        a.glyph[i] !== b.glyph[i] ||
        a.fg[i] !== b.fg[i] ||
        a.bg[i] !== b.bg[i] ||
        a.attr[i] !== b.attr[i]
      ) {
        const hidden =
          a.glyph[i] === TRAIL || b.glyph[i] === TRAIL
            ? " (hidden by a multi-width symbol)"
            : "";
        return `cell ${x},${y}${hidden}: ${describe(a, i)} vs ${describe(b, i)}`;
      }
    }
  }
  return null;
}

function describe(s: Screen, i: number): string {
  return `${JSON.stringify(s.textAt(i % s.cols, Math.floor(i / s.cols)))} fg=${s.fg[i]} bg=${s.bg[i]} attr=${s.attr[i]}`;
}
