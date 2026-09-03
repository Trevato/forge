/**
 * The loop: a mutable screen stack, a dirty flag, and a coalesced frame tick.
 *
 * Not Elm. Every message here would be `{ type: "reposLoaded", repos }`, the
 * immutable-model discipline costs a clone per keystroke in TypeScript, and
 * the async story is *worse*: git reads are naturally awaited, and Elm forces
 * each one into a command plus a result message. What we want from Elm — one
 * place that owns state transitions — we get from the stack; what Bubble Tea
 * cannot give us, cancellation, we get for one line, because each stack entry
 * owns an `AbortController` that `pop()` aborts.
 */

import { defect } from "../../kernel/error.ts";
import type { InputEvent, KeyEvent } from "../term/input.ts";
import { InputDecoder } from "../term/input.ts";
import { Renderer, type Cursor } from "../term/render.ts";
import { Screen as Surface, type Rect } from "../term/screen.ts";
import { style } from "../term/style.ts";
import {
  TerminalSession,
  copyToTerminal,
  openInBrowser,
  type Terminal,
  type SessionOpts,
} from "../term/terminal.ts";
import {
  colorDepthFor,
  theme,
  type Theme,
  type ThemeName,
  type Tokens,
} from "../ui/theme.ts";
import { THEME_NAMES } from "../../design/themes.ts";
import { split, len, fill } from "../ui/layout.ts";
import {
  crumbs,
  helpBar,
  menu,
  spinner,
  toast as drawToast,
  card,
  type Tone,
  type CursorPos,
} from "../ui/widgets.ts";
import { binding, find, type Binding } from "./keys.ts";
import { Palette, type Command, type PaletteSearch } from "./palette.ts";
import { truncate } from "../term/width.ts";

/**
 * A screen in the stack. `Surface` is the cell buffer; the parameter is named
 * `screen` to match the drawing vocabulary, and this interface is the *app's*
 * notion of a screen — a page, not a grid.
 */
export interface Screen {
  readonly title: string;
  readonly keys: Binding[];
  render(area: Rect, screen: Surface): void;
  /** True = handled, stop bubbling. Modals return true for everything. */
  key(e: KeyEvent): boolean;
  /**
   * A bracketed-paste payload, already stripped of escapes and C0. Separate
   * from `key` because it is data, not input: it is spliced in one edit, and
   * a screen that does not implement it simply ignores the paste.
   */
  paste?(text: string): boolean;
  /** Async load, cancelled by `signal` when the screen is popped. */
  load?(signal: AbortSignal): Promise<void>;
}

export interface Ctx {
  push(screen: Screen): void;
  pop(): void;
  replace(screen: Screen): void;
  invalidate(): void;
  toast(text: string, tone?: Tone): void;
  /** Where the terminal caret belongs this frame, if anywhere. */
  setCursor(pos: CursorPos | null): void;
  /**
   * Register async work started from a key handler (a sign-in, a commit) so
   * the app counts as busy until it settles. Loads via `Screen.load` are
   * tracked automatically; this is for everything else.
   */
  track<T>(work: Promise<T>): Promise<T>;
  setTheme(name: ThemeName): void;
  quit(): void;
  /**
   * Put text on the user's own clipboard, through their terminal (OSC 52) —
   * the only route that works over SSH. Whether it lands is the far-side
   * terminal's decision and there is no answer to wait for, so a screen may
   * say it was sent and never that it arrived.
   */
  copy(text: string): void;
  /**
   * Open a URL in a browser on the machine this terminal runs on. False when
   * there is no such machine to reach — every SSH session — which a screen
   * must say out loud rather than pretending the keypress did something.
   */
  openUrl(url: string): boolean;
  /**
   * Hand the terminal to another full-screen program and take it back when it
   * exits. Refuses (and returns false through the promise's `handed` flag)
   * when one is already running on this session — nested suspends are how
   * every TUI that shells out ends up wedged.
   */
  suspend<T>(run: (host: RawHost) => Promise<T>): Promise<T | undefined>;
  readonly theme: Theme;
  readonly cols: number;
  readonly rows: number;
  /** ≥100 columns: list plus preview. Below: one pane at a time. */
  readonly twoPane: boolean;
  /** Frame counter, for spinners. */
  readonly tick: number;
  readonly commands: Command[];
}

interface Entry {
  readonly screen: Screen;
  readonly abort: AbortController;
  loading: boolean;
}

/**
 * The terminal, raw, while the UI is suspended. Bytes in both directions pass
 * through verbatim and one chunk at a time — never buffered, never coalesced.
 * A proxy that batches splits a single keypress's bytes across writes, and
 * every terminal-side ESC-disambiguation timer is calibrated on the
 * assumption that it does not: batching is how `ESC[A` becomes Esc, `[`, `A`.
 */
export interface RawHost {
  write(bytes: Uint8Array): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  readonly cols: number;
  readonly rows: number;
  /** The `TERM` the client announced. `Bun.Terminal`'s `name` does not set it. */
  readonly term: string | undefined;
  /** True only for this machine's own stdio — never an SSH channel. */
  readonly local: boolean;
}

const FRAME_MS = 16; // ~60fps; a held `j` repeats far faster than a repaint
const ESC_MS = 25; // idle backstop for Esc-vs-Alt (neovim uses 50)
const TOAST_MS = 4000;
/** Local search runs this long after the last keystroke. */
const PALETTE_DEBOUNCE_MS = 120;
/** Origins are only asked after a real pause — their rate budget is finite. */
const PALETTE_LIVE_MS = 400;

export interface AppOpts extends SessionOpts {
  readonly terminal: Terminal;
  readonly theme?: ThemeName;
  readonly root: (ctx: Ctx) => Screen;
  readonly commands?: (ctx: Ctx) => Command[];
  /** Turns the palette into the global search box. */
  readonly search?: (ctx: Ctx) => PaletteSearch;
  /**
   * Called whenever the theme settles on a new value — the picker closing or
   * `ctx.setTheme`. The loop knows nothing about persistence; the host does.
   */
  readonly onTheme?: (name: ThemeName) => void;
}

export class App {
  private stack: Entry[] = [];
  private surface: Surface;
  private renderer: Renderer;
  private session: TerminalSession;
  private decoder = new InputDecoder();
  private dirty = true;
  private running = false;
  private themeName: ThemeName;
  private cursor: CursorPos | null = null;
  private overlay: "none" | "help" | "palette" | "theme" = "none";
  private palette = new Palette();
  private themeIndex = 0;
  private toastState: { text: string; tone: Tone; until: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private frames = 0;
  /** Set while another program owns the terminal (`suspend`). */
  private suspended = false;
  private raw: ((chunk: Uint8Array) => void) | null = null;
  private rawResize: ((cols: number, rows: number) => void) | null = null;
  private paletteTimers: ReturnType<typeof setTimeout>[] = [];
  private paletteAbort: AbortController | null = null;
  private search: PaletteSearch | undefined;
  readonly ctx: Ctx;
  readonly commands: Command[] = [];

  private pending = 0;

  /** True while any screen is loading or tracked work is in flight. */
  get busy(): boolean {
    return this.pending > 0 || this.stack.some((e) => e.loading);
  }

  /**
   * Nothing in flight *and* nothing waiting to be drawn.
   *
   * `busy` alone is not the same question, and the difference is where a
   * headless test goes flaky: work can finish, mark the screen dirty, and
   * leave the next paint sitting on a frame timer — so a harness that only
   * waits for `busy` can read the *previous* frame's cells and assert
   * against a screen the app has already decided is out of date. This is the
   * whole condition, which is what makes waiting on it a settlement rather
   * than a guess.
   */
  get settled(): boolean {
    return !this.dirty && !this.busy;
  }

  /** Frames actually painted. A harness watches it stop changing. */
  get frameCount(): number {
    return this.frames;
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.pending++;
    return work.finally(() => {
      this.pending--;
      this.invalidate();
    });
  }

  /** Global bindings. Reserved: no screen may steal `?`, `:` or Ctrl+C. */
  readonly globals: Binding[] = [
    binding(["?"], "help"),
    binding([":", "ctrl+k"], "palette"),
    binding(["t"], "theme"),
    binding(["q", "esc"], "back"),
    binding(["ctrl+c"], "quit", { hidden: true }),
  ];

  constructor(private readonly opts: AppOpts) {
    const size = opts.terminal.size();
    this.surface = new Surface(size.cols, size.rows);
    this.renderer = new Renderer(colorDepthFor(opts.terminal.term));
    this.session = new TerminalSession(opts.terminal, opts);
    this.themeName = opts.theme ?? "dark";
    this.themeIndex = Math.max(0, THEME_NAMES.indexOf(this.themeName));
    this.ctx = this.makeCtx();
    this.commands = opts.commands?.(this.ctx) ?? [];
    this.search = opts.search?.(this.ctx);
    this.push(opts.root(this.ctx));
  }

  private makeCtx(): Ctx {
    const app = this;
    return {
      push: (s) => app.push(s),
      pop: () => app.pop(),
      replace: (s) => app.replace(s),
      invalidate: () => app.invalidate(),
      toast: (text, tone) => app.toast(text, tone),
      track: (work) => app.track(work),
      setCursor: (pos) => {
        app.cursor = pos;
      },
      setTheme: (name) => app.applyTheme(name),
      quit: () => app.stop(),
      copy: (text) => copyToTerminal(app.opts.terminal, text),
      openUrl: (url) => openInBrowser(app.opts.terminal, url),
      suspend: (run) => app.suspend(run),
      get theme() {
        return theme(app.themeName);
      },
      get cols() {
        return app.surface.cols;
      },
      get rows() {
        return app.surface.rows;
      },
      get twoPane() {
        return app.surface.cols >= 100;
      },
      get tick() {
        return app.frames;
      },
      get commands() {
        return app.commands;
      },
    };
  }

  // ---- stack ----

  push(screen: Screen): void {
    const entry: Entry = {
      screen,
      abort: new AbortController(),
      loading: false,
    };
    this.stack.push(entry);
    this.startLoad(entry);
    this.invalidate();
  }

  pop(): void {
    if (this.stack.length <= 1) return;
    // The cancellation Bubble Tea's commands cannot do: popping a screen
    // aborts whatever it had in flight, and nothing lands on a dead screen.
    this.stack.pop()?.abort.abort();
    this.invalidate();
  }

  replace(screen: Screen): void {
    this.stack.pop()?.abort.abort();
    this.push(screen);
  }

  private startLoad(entry: Entry): void {
    if (entry.screen.load === undefined) return;
    entry.loading = true;
    void entry.screen
      .load(entry.abort.signal)
      .catch((e: unknown) => {
        // Every failure becomes a toast; nothing throws into the loop, and no
        // single bad read may drop the session.
        if (!entry.abort.signal.aborted)
          this.toast(e instanceof Error ? e.message : String(e), "danger");
      })
      .finally(() => {
        entry.loading = false;
        this.invalidate();
      });
  }

  private top(): Entry {
    const entry = this.stack[this.stack.length - 1];
    // An empty stack is a broken invariant, not an expected outcome.
    if (entry === undefined)
      defect("tui.empty_stack", "the screen stack is empty");
    return entry;
  }

  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  /**
   * Ask for a frame. Not a 60fps heartbeat: a repaint is scheduled only when
   * something has actually changed, and the timer stops as soon as nothing
   * has.
   *
   * The loop used to tick every 16ms for the whole life of a session and
   * return immediately when nothing was dirty — correct, and almost free
   * for one terminal. For two hundred SSH sessions it is twelve thousand
   * wakeups a second to decide, twelve thousand times, that there is nothing
   * to draw. An idle session should cost nothing, and now does.
   *
   * Frames are still *coalesced* at FRAME_MS, which is the property that
   * matters for a held `j`: a key repeat far faster than the refresh rate
   * still produces one repaint per frame, not one per keystroke.
   */
  private schedule(): void {
    // While an editor owns the terminal nothing may paint, so nothing may
    // ask to: without this the dirty flag would keep re-arming the timer for
    // the whole editing session, sixty wakeups a second to draw nothing.
    if (this.suspended) return;
    if (!this.running || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.frame();
      // A spinner is animation and a toast expires, so both keep asking for
      // the next frame; everything else settles and the timer goes quiet.
      if (this.animating()) this.schedule();
    }, FRAME_MS);
  }

  /** Is anything on screen still moving under its own steam? */
  private animating(): boolean {
    return (
      this.dirty ||
      this.toastState !== null ||
      this.stack.some((e) => e.loading)
    );
  }

  /** The one place the theme changes, so persistence has one hook to sit on. */
  private applyTheme(name: ThemeName, notify = true): void {
    if (this.themeName !== name || notify) {
      this.themeName = name;
      this.themeIndex = Math.max(0, THEME_NAMES.indexOf(name));
      if (notify) this.opts.onTheme?.(name);
    }
    this.invalidate();
  }

  toast(text: string, tone: Tone = "default"): void {
    this.toastState = { text, tone, until: Date.now() + TOAST_MS };
    this.invalidate();
  }

  // ---- lifecycle ----

  start(): void {
    if (this.running) return;
    this.running = true;
    this.session.enter();
    this.opts.terminal.onInput((chunk) => this.onChunk(chunk));
    this.opts.terminal.onResize((cols, rows) => this.onResize(cols, rows));
    this.opts.terminal.onClose(() => this.stop());
    this.frame();
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.escTimer !== null) clearTimeout(this.escTimer);
    for (const t of this.paletteTimers) clearTimeout(t);
    this.paletteTimers = [];
    this.paletteAbort?.abort();
    for (const entry of this.stack) entry.abort.abort();
    this.session.leave();
  }

  /**
   * Suspend the UI, run something with the raw terminal, resume.
   *
   * Nothing here trusts the terminal to have preserved anything: on resume
   * the alt screen is re-entered, the renderer invalidated, and a full frame
   * painted. tcell, gocui, tview and tig all reached the same conclusion —
   * 1049's save/restore is a per-terminal courtesy, and the child usually
   * cleared the buffer anyway.
   */
  async suspend<T>(run: (host: RawHost) => Promise<T>): Promise<T | undefined> {
    if (this.raw !== null || this.suspended) return undefined;
    this.suspended = true;
    const app = this;
    let onData: (chunk: Uint8Array) => void = () => undefined;
    const resizes: ((cols: number, rows: number) => void)[] = [];
    this.raw = (chunk) => onData(chunk);
    this.rawResize = (cols, rows) => {
      for (const cb of resizes) cb(cols, rows);
    };
    const host: RawHost = {
      write: (bytes) => app.opts.terminal.write(bytes),
      onData: (cb) => {
        onData = cb;
      },
      onResize: (cb) => resizes.push(cb),
      get cols() {
        return app.surface.cols;
      },
      get rows() {
        return app.surface.rows;
      },
      term: this.opts.terminal.term,
      local: this.opts.terminal.local === true,
    };
    this.session.suspend();
    try {
      return await run(host);
    } finally {
      this.raw = null;
      this.rawResize = null;
      this.suspended = false;
      // Swallow whatever the client answered while we were away — nvim asks
      // for a Primary DA on the way out and the reply lands here, on the
      // resumed input stream, as a stray `ESC[?…c`.
      this.decoder = new InputDecoder();
      this.session.resume();
      this.renderer.invalidate();
      this.invalidate();
      this.frame();
    }
  }

  private onChunk(chunk: Uint8Array): void {
    if (this.raw !== null) {
      this.raw(chunk);
      return;
    }
    for (const event of this.decoder.push(chunk)) this.dispatch(event);
    if (this.escTimer !== null) clearTimeout(this.escTimer);
    // Read batching settles Alt+key in the common case; this timer is the
    // backstop for the split-read case, and 25ms is short enough not to be
    // felt (ncurses' 1000ms ESCDELAY is the notorious counter-example).
    if (this.decoder.pending > 0)
      this.escTimer = setTimeout(() => {
        for (const event of this.decoder.flush()) this.dispatch(event);
      }, ESC_MS);
  }

  private onResize(cols: number, rows: number): void {
    // A suspended child owns the screen: it gets the new size first, and our
    // own buffer is resized behind it so the resumed repaint is correct.
    this.rawResize?.(Math.max(1, cols), Math.max(1, rows));
    if (cols === this.surface.cols && rows === this.surface.rows) return;
    // A resize invalidates every assumption; never diff across one.
    this.surface = new Surface(Math.max(1, cols), Math.max(1, rows));
    this.renderer.invalidate();
    this.invalidate();
  }

  /** Feed one event as if it arrived from the terminal (tests, SSH adapters). */
  dispatch(event: InputEvent): void {
    if (event.type === "resize") {
      this.onResize(event.cols, event.rows);
      return;
    }
    if (event.type === "mouse") {
      // The wheel is the only mouse input we accept, and it means exactly
      // what the arrow keys mean — so it becomes one, and no screen needs to
      // know the mouse exists.
      this.dispatch({
        type: "key",
        key: event.kind === "wheel-up" ? "up" : "down",
        ctrl: false,
        alt: false,
        shift: false,
      });
      return;
    }
    if (event.type === "paste") {
      this.top().screen.paste?.(event.text);
      this.invalidate();
      return;
    }
    this.onKey(event);
  }

  private onKey(e: KeyEvent): void {
    this.invalidate();
    // Ctrl+C always quits, from any overlay and any screen; Ctrl+Z is
    // swallowed (over SSH there is no process group to suspend into).
    if (e.ctrl && e.key === "c") return this.stop();
    if (this.overlay !== "none") {
      this.overlayKey(e);
      return;
    }

    // The screen sees the key first, so a textarea can own `:` and `?` while
    // it has focus — but a screen that does not handle them cannot swallow
    // them either.
    if (this.top().screen.key(e)) return;

    // Ctrl+Z is swallowed *after* the screen has had it: over SSH there is no
    // process group to suspend into, so it must never reach a shell — but the
    // editor legitimately owns it as undo, and stealing it above would have
    // meant an editor with no undo key.
    if (e.ctrl && e.key === "z") return;

    const hit = find(this.globals, e);
    switch (hit?.help) {
      case "help":
        this.overlay = "help";
        return;
      case "palette":
        this.overlay = "palette";
        this.palette.open(this.commands);
        this.schedulePaletteSearch();
        return;
      case "theme":
        this.overlay = "theme";
        return;
      case "back":
        if (this.stack.length > 1) this.pop();
        else if (e.key === "q") this.stop();
        return;
      default:
        return;
    }
  }

  /**
   * Search on a pause, not on a keystroke.
   *
   * Two timers, because there are two costs. The local half — repos, issues,
   * `git grep` — is cheap and bounded, so it runs 120ms after you stop typing.
   * The live half asks every connected origin's own search API, spending
   * somebody's rate budget, so it waits for a real pause at 400ms and only
   * then re-runs the same query with `live` set. Both are cancelled by the
   * next keystroke, and a result that lands for a query nobody is typing any
   * more is dropped rather than drawn.
   */
  private schedulePaletteSearch(): void {
    const search = this.search;
    if (search === undefined) return;
    this.paletteAbort?.abort();
    if (this.paletteTimers.length > 0)
      for (const t of this.paletteTimers) clearTimeout(t);
    this.paletteTimers = [];
    const query = this.palette.query;
    if (query.trim() === "") {
      this.palette.setResults([]);
      this.paletteAbort = null;
      return;
    }
    const abort = new AbortController();
    this.paletteAbort = abort;
    this.palette.searching = true;
    const run = (live: boolean): void => {
      void search(query, live, abort.signal)
        .then((items) => {
          if (abort.signal.aborted || this.palette.query !== query) return;
          this.palette.setResults(items);
          this.invalidate();
        })
        .catch(() => {
          if (!abort.signal.aborted) this.palette.searching = false;
        });
    };
    this.paletteTimers = [
      setTimeout(() => run(false), PALETTE_DEBOUNCE_MS),
      setTimeout(() => run(true), PALETTE_LIVE_MS),
    ];
  }

  private overlayKey(e: KeyEvent): void {
    if (this.overlay === "palette") {
      const before = this.palette.query;
      const result = this.palette.key(e);
      if (this.palette.query !== before) this.schedulePaletteSearch();
      if (result === "close") this.overlay = "none";
      else if (result !== null) {
        this.overlay = "none";
        void Promise.resolve(result.run()).catch((err: unknown) =>
          this.toast(
            err instanceof Error ? err.message : String(err),
            "danger",
          ),
        );
      }
      return;
    }
    if (this.overlay === "theme") {
      let chosen = false;
      if (e.key === "down" || e.key === "j")
        this.themeIndex = (this.themeIndex + 1) % THEME_NAMES.length;
      else if (e.key === "up" || e.key === "k")
        this.themeIndex =
          (this.themeIndex - 1 + THEME_NAMES.length) % THEME_NAMES.length;
      else if (
        e.key === "enter" ||
        e.key === "esc" ||
        e.key === "t" ||
        e.key === "q"
      ) {
        this.overlay = "none";
        chosen = true;
      }
      // Live preview: the whole screen repaints in the highlighted theme, so
      // choosing is a matter of looking rather than remembering. Only the
      // choice is announced — not every frame of the browse.
      this.applyTheme(THEME_NAMES[this.themeIndex] ?? this.themeName, chosen);
      return;
    }
    this.overlay = "none";
  }

  // ---- rendering ----

  /** Render one frame if anything changed. Safe to call directly in a test. */
  frame(): void {
    // While something else owns the screen we paint nothing at all: one stray
    // frame in the middle of an editor session is a corrupted display.
    if (this.suspended) return;
    if (this.toastState !== null && Date.now() > this.toastState.until) {
      this.toastState = null;
      this.dirty = true;
    }
    if (this.stack.some((e) => e.loading)) this.dirty = true; // spinner
    if (!this.dirty) return;
    this.dirty = false;
    this.frames++;
    this.cursor = null;

    const c = theme(this.themeName).c;
    const s = this.surface;
    // The whole screen is painted in the theme's background: a TUI that lets
    // the user's own background show through looks like six half-themes.
    s.clear(style(c.fg, c.bg));

    if (s.cols < 20 || s.rows < 10) {
      s.line(
        s.rect(),
        Math.floor(s.rows / 2),
        truncate("Resize your terminal", s.cols),
        style(c.mutedFg, c.bg),
        "center",
      );
      this.flush();
      return;
    }

    const [head, crumbRow, body, foot] = split(s.rect(), "v", [
      len(1),
      len(1),
      fill(1),
      len(1),
    ]);
    this.drawHeader(head!, c);
    crumbs(
      s,
      crumbRow!,
      c,
      this.stack.map((e) => e.screen.title),
    );

    try {
      this.top().screen.render(body!, s);
    } catch (e) {
      // One bad render must not drop the session.
      s.line(body!, 0, `render error: ${String(e)}`, style(c.danger, c.bg));
    }

    this.drawFooter(foot!, c);
    if (this.overlay === "palette")
      this.cursor = this.palette.render(s, body!, c);
    if (this.overlay === "help") this.drawHelp(body!, c);
    if (this.overlay === "theme") this.drawThemes(body!, c);
    this.flush();
  }

  private drawHeader(r: Rect, c: Tokens): void {
    const s = this.surface;
    s.fill(r, " ", style(c.mutedFg, c.muted));
    s.text(r.x + 1, r.y, "forge", style(c.fg, c.muted, 1), r.x + r.w);
    const right = `${theme(this.themeName).label}`;
    s.line(r, 0, `${right} `, style(c.faint, c.muted), "right");
  }

  private drawFooter(r: Rect, c: Tokens): void {
    const s = this.surface;
    if (this.toastState !== null) {
      drawToast(s, r, c, {
        text: this.toastState.text,
        tone: this.toastState.tone,
      });
      return;
    }
    const bindings = [...this.top().screen.keys, ...this.globals];
    helpBar(s, r, c, bindings);
    // Every async boundary shows a spinner in the status bar, never a blank
    // screen and never a modal.
    if (this.stack.some((e) => e.loading))
      spinner(s, r.x + r.w - 2, r.y, c, this.frames);
  }

  private drawHelp(area: Rect, c: Tokens): void {
    const s = this.surface;
    const bindings = [...this.top().screen.keys, ...this.globals].filter(
      (b) => b.hidden !== true,
    );
    const inner = card(s, area, c, { title: "Keys", focused: true });
    bindings.forEach((b, i) => {
      if (i >= inner.h) return;
      const keys = truncate(b.keys.join(" / "), 14);
      s.text(
        inner.x,
        inner.y + i,
        keys,
        style(c.accent, c.card),
        inner.x + inner.w,
      );
      s.text(
        inner.x + 16,
        inner.y + i,
        truncate(b.help, Math.max(0, inner.w - 16)),
        style(b.disabled === true ? c.faint : c.fg, c.card),
        inner.x + inner.w,
      );
    });
  }

  private drawThemes(area: Rect, c: Tokens): void {
    const width = 28;
    const r = {
      x: area.x + Math.max(0, area.w - width - 2),
      y: area.y,
      w: Math.min(width, area.w),
      h: Math.min(THEME_NAMES.length + 2, area.h),
    };
    menu(this.surface, r, c, {
      title: "Theme",
      items: THEME_NAMES.map((n) => theme(n).label),
      selected: this.themeIndex,
    });
  }

  private flush(): void {
    const cursor: Cursor | null =
      this.cursor === null ? null : { x: this.cursor.x, y: this.cursor.y };
    const out = this.renderer.render(this.surface, cursor);
    if (out !== "") this.opts.terminal.write(new TextEncoder().encode(out));
  }

  /** The buffer as it stands — for snapshot tests and the gallery check. */
  get screen(): Surface {
    return this.surface;
  }
}
