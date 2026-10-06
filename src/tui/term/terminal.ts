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
  CURSOR_SHAPE_RESET,
  KITTY_KEYS_POP,
  WRAP_OFF,
  WRAP_ON,
} from "./ansi.ts";
import {
  capabilitiesFor,
  type GraphicsSetting,
  type IconSetting,
  type TermCapabilities,
} from "./graphics.ts";
import { Screen, TRAIL } from "./screen.ts";
import { DEFAULT, PLAIN, type Style } from "./style.ts";
import { clusters } from "./width.ts";

/** The window in pixels, when the client bothered to report one. */
export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export interface Terminal {
  write(bytes: Uint8Array): void;
  onInput(cb: (chunk: Uint8Array) => void): void;
  size(): { cols: number; rows: number };
  onResize(cb: (cols: number, rows: number) => void): void;
  onClose(cb: () => void): void;
  /** Release the transport (raw mode, the channel). Idempotent. */
  close(): void;
  /** The `TERM` the client announced; the only env var SSH forwards. */
  readonly term?: string | undefined;
  /**
   * The window's size in pixels, when the transport has one. `pty-req` and
   * `window-change` both carry it and most clients send zeros, so this is a
   * bonus that makes image placement exact — never something to require.
   */
  readonly pixelSize?: PixelSize | undefined;
  /**
   * True only for the terminal attached to *this* machine's stdio. An SSH
   * channel and a test harness are both false, which is the difference
   * between "I can open your browser" and "I can only show you a link".
   */
  readonly local?: boolean;
}

/** The two per-user preferences that feed capability detection. */
export interface TerminalPrefs {
  readonly graphics?: GraphicsSetting | undefined;
  readonly icons?: IconSetting | undefined;
}

/**
 * What this session can do, from what the transport knows: the client's
 * `TERM`, its size, and its pixel size if it sent one. Preferences override
 * the guesses and come from the caller — `term/` does not read the database,
 * because that is the boundary that lets one runtime serve stdio, an SSH
 * channel and a test with no branch anywhere.
 */
export function terminalCapabilities(
  terminal: Terminal,
  prefs: TerminalPrefs = {},
): TermCapabilities {
  const size = terminal.size();
  const pixels = terminal.pixelSize;
  return capabilitiesFor({
    term: terminal.term,
    graphics: prefs.graphics,
    icons: prefs.icons,
    cols: size.cols,
    rows: size.rows,
    pixelWidth: pixels?.width,
    pixelHeight: pixels?.height,
  });
}

const encoder = new TextEncoder();

/**
 * Put text on the user's system clipboard, through the terminal itself.
 *
 * OSC 52 is the only mechanism that works over SSH: the sequence travels
 * back down the connection and the *client's* terminal does the copying, so
 * no clipboard binary has to exist on the server. Support is a property of
 * the far-side terminal — iTerm2, Ghostty, kitty and WezTerm do it, Apple's
 * Terminal does not — and there is no reply to read, so a caller can say it
 * was sent but never that it arrived.
 */
export function copyToTerminal(terminal: Terminal, text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  terminal.write(encoder.encode(`\x1b]52;c;${encoded}\x07`));
}

/**
 * Open a URL in a browser on the machine this terminal is attached to.
 *
 * Only the local stdio session can: over SSH the browser is on the far side
 * of the connection and nothing here can reach it, which is precisely why
 * the connect screens print a QR code and a short link. Returns whether it
 * was attempted, so a screen can say the true thing either way.
 */
export function openInBrowser(terminal: Terminal, url: string): boolean {
  if (terminal.local !== true) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    // argv, never a shell — the URL is data and must stay data.
    Bun.spawn([opener, url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export interface SessionOpts {
  /**
   * Mouse reporting, **on** unless a caller says otherwise.
   *
   * It has one real cost: while it is on, the terminal's own text selection
   * needs Shift held. That is the most common complaint about mouse-enabled
   * TUIs and the reason this was opt-in for as long as nothing was clickable.
   * Now that rows, tabs, the where-strip and the help hints all are, the
   * balance is the other way — a forge you can only drive from memory is
   * worse than a selection gesture that grew a modifier — so it is on, and
   * the help overlay says "shift-drag selects text" out loud.
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

  /** Reporting is on unless the caller explicitly turned it off. */
  private get mouse(): boolean {
    return this.opts.mouse !== false;
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.send(
      ALT_ENTER +
        WRAP_OFF +
        CURSOR_HIDE +
        ERASE_ALL +
        PASTE_ON +
        (this.mouse ? MOUSE_ON : ""),
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

  /**
   * Give the terminal back to another full-screen program (an editor) without
   * ending the session.
   *
   * Every mode we set is undone, in the order `leave()` uses, and one thing
   * `leave()` does not do is added: auto-wrap goes back **on**. The renderer
   * runs with `?7l` because it positions absolutely; nvim assumes wrap is on
   * and renders wrongly without it. The alt screen is left last, after the
   * SGR reset, for the same reason it is there — attributes must not leak
   * into the buffer we are handing over.
   */
  suspend(): void {
    this.send(
      SGR_RESET +
        PASTE_OFF +
        MOUSE_OFF +
        FOCUS_OFF +
        CURSOR_SHOW +
        WRAP_ON +
        ALT_LEAVE,
    );
  }

  /**
   * Take it back. Unconditional and state-independent on purpose: the child
   * may have crashed, in which case it restored nothing, and "undo what we
   * think it did" is exactly the reasoning that leaves a broken terminal.
   *
   * Two additions beyond `enter()`, both measured against real nvim: it exits
   * having set `ESC[2 q` (a steady block) and never resets the cursor shape,
   * so we send `ESC[0 q`; and it pushes kitty keyboard flags it does not pop,
   * so we pop them (harmless where unsupported).
   */
  resume(): void {
    this.send(
      ALT_ENTER +
        WRAP_OFF +
        CURSOR_HIDE +
        ERASE_ALL +
        CURSOR_SHAPE_RESET +
        KITTY_KEYS_POP +
        PASTE_ON +
        (this.mouse ? MOUSE_ON : ""),
    );
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
      // Terminal is restored; the crash goes to the user's own stderr.
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
    // The one terminal that is on the same machine as the process: `o` can
    // open a browser here and nowhere else.
    local: true,
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
  /** Pretend the client reported a window size in pixels (a `pty-req` does). */
  setPixelSize(width: number, height: number): void;
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
export function headlessTerminal(
  cols = 80,
  rows = 24,
  term?: string,
): HeadlessTerminal {
  let cursorCols = cols;
  let cursorRows = rows;
  let pixels: PixelSize | undefined;
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
    get term() {
      return term;
    },
    get pixelSize() {
      return pixels;
    },
    setPixelSize(width, height) {
      pixels = { width, height };
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
  /** The OSC 8 URI currently open in the byte stream we are consuming. */
  private link = "";
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
      if (input[i + 1] === "]") {
        // OSC. We decode exactly one: hyperlinks, because a virtual terminal
        // that swallowed them could not check that we open and close them in
        // the right places.
        const end = oscEnd(input, i);
        if (end === -1) return;
        this.osc(input.slice(i + 2, end.body));
        i = end.next;
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
      this.x +=
        this.link === ""
          ? this.screen.set(this.x, this.y, cluster, this.cur)
          : this.screen.linkText(this.x, this.y, cluster, this.cur, this.link) -
            this.x;
    }
    return i;
  }

  /** OSC 8 only: `8;<params>;<uri>`. An empty URI closes the open link. */
  private osc(body: string): void {
    if (!body.startsWith("8;")) return;
    const semi = body.indexOf(";", 2);
    this.link = semi === -1 ? "" : body.slice(semi + 1);
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

/**
 * Where an OSC starting at `i` ends: `body` is one past its payload and
 * `next` one past its terminator (BEL, or ST). -1 when it is incomplete.
 */
function oscEnd(s: string, i: number): { body: number; next: number } | -1 {
  for (let j = i + 2; j < s.length; j++) {
    if (s[j] === "\x07") return { body: j, next: j + 1 };
    if (s[j] === "\x1b" && s[j + 1] === "\\") return { body: j, next: j + 2 };
  }
  return -1;
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
        a.attr[i] !== b.attr[i] ||
        a.linkAt(x, y) !== b.linkAt(x, y)
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
