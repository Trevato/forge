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
import { MOUSE_OFF, MOUSE_ON } from "../term/ansi.ts";
import type { InputEvent, KeyEvent, MouseEvent } from "../term/input.ts";
import { InputDecoder } from "../term/input.ts";
import { Renderer, type Cursor } from "../term/render.ts";
import { G, Screen as Surface, type Rect } from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import {
  GRAPHICS_SETTINGS,
  ICON_SETTINGS,
  type GraphicsSetting,
  type IconSet,
  type IconSetting,
  type TermCapabilities,
} from "../term/graphics.ts";
import {
  TerminalSession,
  copyToTerminal,
  openInBrowser,
  terminalCapabilities,
  type Terminal,
  type SessionOpts,
  type TerminalPrefs,
} from "../term/terminal.ts";
import {
  colorDepthFor,
  theme,
  type Theme,
  type ThemeName,
  type Tokens,
} from "../ui/theme.ts";
import { THEME_NAMES } from "../../design/themes.ts";
import {
  MIN_COLS,
  MIN_ROWS,
  TWO_PANE_COLS,
  contains,
  fill,
  len,
  split,
} from "../ui/layout.ts";
import { clearImages } from "../ui/image.ts";
import { fileIcon, icon } from "../ui/icons.ts";
import {
  crumbs,
  helpBar,
  spinner,
  toast as drawToast,
  card,
  type Tone,
  type CursorPos,
} from "../ui/widgets.ts";
import { binding, find, keyFor, type Binding } from "./keys.ts";
import { message } from "../screens/common.ts";
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
  /** Palette rows only this screen offers, listed after the app's own. */
  commands?(): Command[];
  /** The local repository this screen shows, so `leaveRepo` can find it when it is deleted. */
  readonly repoId?: string;
}

/**
 * A click, in the coordinates the handler cares about.
 *
 * `x`/`y` are *inside* the region — a list that registered one region for its
 * whole body turns `y` into a row index with no arithmetic at the call site,
 * which is the reason regions are rectangles rather than cells.
 */
export interface HitEvent {
  /** Cell offset inside the region; 0,0 is its top-left. */
  readonly x: number;
  readonly y: number;
  /** The same cell in screen coordinates. */
  readonly col: number;
  readonly row: number;
  /** A second press on the same region inside `DOUBLE_MS`. */
  readonly double: boolean;
  readonly button: 0 | 1 | 2;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/**
 * What a region does when the pointer arrives. A bare function is the common
 * case (click only); the object form adds the wheel.
 */
export interface HitTarget {
  click?(e: HitEvent): void;
  /** Wheel notch, in rows: negative up, positive down. */
  wheel?(rows: number, e: HitEvent): void;
}

export type Hit = HitTarget | ((e: HitEvent) => void);

/**
 * An image placed by `ui/image.ts`, structurally — the loop writes the bytes
 * and never looks inside them, so it does not import the image pipeline's
 * types to say so.
 */
export interface ImagePlacement {
  readonly id: number;
  readonly rect: Rect;
  readonly bytes: readonly Uint8Array[];
}

export interface Ctx {
  push(screen: Screen): void;
  pop(): void;
  replace(screen: Screen): void;
  /**
   * A repository is gone: drop its lowest screen and everything above it, down
   * to the one beneath (never the root), so nothing reads the deleted row.
   */
  leaveRepo(repoId: string): void;
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
   * Mouse reporting on or off. Off is what lets the terminal's own
   * selection work — a link dialog turns it off while it is open so a URL
   * can be dragged over and copied the ordinary way.
   */
  mouse(on: boolean): void;
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
  /**
   * Claim a rectangle for the pointer, for this frame only.
   *
   * The registry is cleared at the top of every paint and rebuilt by the
   * screens that draw, so a region can never outlive the pixels it stands
   * for — the bug every retained-mode hit table eventually has. Regions are
   * searched newest-first, so whatever drew last (an overlay, a dialog) is
   * what a click reaches, with no z-index to keep in sync.
   */
  hit(rect: Rect, on: Hit): void;
  /**
   * Show one image this frame, or none. The bytes go out after the frame,
   * raw; passing null (or simply not calling it) removes whatever the last
   * frame placed, which is what makes a tab switch, a pop and a resize all
   * clean up by themselves.
   */
  placeImage(p: ImagePlacement | null): void;
  /** What this terminal can do: graphics protocol, icon set, cell geometry. */
  readonly caps: TermCapabilities;
  /** `caps.icons`, said in one word — the argument every icon call takes. */
  readonly icons: IconSet;
  readonly theme: Theme;
  readonly cols: number;
  readonly rows: number;
  /**
   * At least `TWO_PANE_COLS` wide: a list sits beside its detail. Below,
   * `beside()` stacks the two, and a screen with no detail to stack draws
   * one pane at a time.
   */
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
/** Two presses on one region inside this are a double-click. */
const DOUBLE_MS = 450;
/** One wheel notch, in rows. Three is what every terminal and browser uses. */
const WHEEL_ROWS = 3;
/** Local search runs this long after the last keystroke. */
const PALETTE_DEBOUNCE_MS = 120;
/** Origins are only asked after a real pause — their rate budget is finite. */
const PALETTE_LIVE_MS = 400;

export interface AppOpts extends SessionOpts {
  readonly terminal: Terminal;
  readonly theme?: ThemeName;
  /** The stored graphics/icons preferences, if this session has an account. */
  readonly prefs?: TerminalPrefs;
  /**
   * Called when the terminal picker settles on new preferences. The loop
   * knows nothing about persistence; the host does — the same contract
   * `onTheme` has.
   */
  readonly onPrefs?: (prefs: {
    graphics: GraphicsSetting;
    icons: IconSetting;
  }) => void;
  /** How long a toast stays up. @default 4000 */
  readonly toastMs?: number;
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
  /** Where the picker's cursor is: a theme row, then graphics, then icons. */
  private pickerRow = 0;
  private graphics: GraphicsSetting;
  private iconSetting: IconSetting;
  private capabilities: TermCapabilities;
  /** Cleared and rebuilt every paint; searched newest-first on a click. */
  private regions: { rect: Rect; on: HitTarget }[] = [];
  private lastClick: { rect: Rect; at: number } | null = null;
  /** The image this frame wants, and the one the terminal is holding. */
  private wanted: ImagePlacement | null = null;
  private placed: ImagePlacement | null = null;
  /** Set whenever the renderer is invalidated: the picture must be re-sent. */
  private imagesStale = false;
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

  /**
   * No palette search waiting on its debounce or in flight. `settled` does
   * not count it, so typing in the palette stays snappy under a harness; a
   * test that acts on the results waits on this, not on a sleep.
   */
  get paletteSettled(): boolean {
    return this.paletteTimers.length === 0;
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
    // Ctrl+T, not `t`: inside a workspace `t` is the file finder, and a
    // global that only works on *some* screens is worse than one more
    // modifier. One key, everywhere, whatever has focus.
    binding(["ctrl+t"], "appearance"),
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
    this.pickerRow = this.themeIndex;
    this.graphics = opts.prefs?.graphics ?? "auto";
    this.iconSetting = opts.prefs?.icons ?? "auto";
    this.capabilities = this.readCapabilities();
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
      leaveRepo: (id) => app.leaveRepo(id),
      invalidate: () => app.invalidate(),
      toast: (text, tone) => app.toast(text, tone),
      track: (work) => app.track(work),
      setCursor: (pos) => {
        app.cursor = pos;
      },
      setTheme: (name) => app.applyTheme(name),
      quit: () => app.stop(),
      copy: (text) => copyToTerminal(app.opts.terminal, text),
      mouse: (on) =>
        app.opts.terminal.write(
          new TextEncoder().encode(on ? MOUSE_ON : MOUSE_OFF),
        ),
      openUrl: (url) => openInBrowser(app.opts.terminal, url),
      suspend: (run) => app.suspend(run),
      hit: (rect, on) => {
        if (rect.w <= 0 || rect.h <= 0) return;
        app.regions.push({
          rect,
          on: typeof on === "function" ? { click: on } : on,
        });
      },
      placeImage: (p) => {
        app.wanted = p;
      },
      get caps() {
        return app.capabilities;
      },
      get icons() {
        return app.capabilities.icons;
      },
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
        return app.surface.cols >= TWO_PANE_COLS;
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

  leaveRepo(repoId: string): void {
    const at = this.stack.findIndex((e) => e.screen.repoId === repoId);
    if (at < 0) return;
    for (const e of this.stack.splice(Math.max(at, 1))) e.abort.abort();
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
          this.toast(message(e), "danger");
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

  /**
   * Re-ask the transport what it can do. Cheap arithmetic over `TERM`, the
   * size and the client's reported pixels — recomputed rather than cached
   * across a resize, because the pixel size is exactly what a resize moves.
   */
  private readCapabilities(): TermCapabilities {
    return terminalCapabilities(this.opts.terminal, {
      graphics: this.graphics,
      icons: this.iconSetting,
    });
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
    this.toastState = { text, tone, until: Date.now() + (this.opts.toastMs ?? TOAST_MS) };
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
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);
    if (c !== this.surface.cols || r !== this.surface.rows) {
      // A resize invalidates every assumption; never diff across one. The
      // screens keep their own state — a cursor, a scroll — and re-lay
      // themselves on the next frame, which `invalidate` asks for now.
      this.surface = new Surface(c, r);
      this.capabilities = this.readCapabilities();
      this.renderer.invalidate();
      // A kitty placement is anchored to a cell, so after a reflow it is
      // sitting on top of unrelated text until it is sent again.
      this.imagesStale = true;
      this.invalidate();
    }
    // A suspended child owns the screen and hears every window-change, even
    // one that changed nothing. The buffer went first so that `host.cols`
    // already says the new size inside the child's own callback; nothing
    // paints over the child, because `schedule` stays quiet while suspended.
    this.rawResize?.(c, r);
  }

  /** Feed one event as if it arrived from the terminal (tests, SSH adapters). */
  dispatch(event: InputEvent): void {
    if (event.type === "resize") {
      this.onResize(event.cols, event.rows);
      return;
    }
    if (event.type === "mouse") {
      this.onMouse(event);
      return;
    }
    if (event.type === "paste") {
      this.top().screen.paste?.(event.text);
      this.invalidate();
      return;
    }
    this.onKey(event);
  }

  /**
   * The pointer, resolved against the regions the last frame drew.
   *
   * Newest-first is the whole z-order: a screen registers its rows, an
   * overlay registers a backdrop and then its own rows, and a click walks
   * back through that list until something takes it. Nothing here reaches a
   * `Screen.key` — mouse input is not a synthetic keystroke, and a screen
   * that wants a click says so with `ctx.hit`. The one exception is a wheel
   * notch nobody claimed, which becomes arrow keys because that is what a
   * wheel has always meant.
   */
  private onMouse(e: MouseEvent): void {
    if (e.kind === "release") return;
    const wheel = e.kind === "wheel-up" || e.kind === "wheel-down";
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i]!;
      if (!contains(region.rect, e.x, e.y)) continue;
      const handler = wheel ? region.on.wheel : region.on.click;
      // A region that does not handle *this* gesture is not in the way of
      // one that does: a wheel over a clickable row still scrolls the list
      // the row is in.
      if (handler === undefined) continue;
      const hit = this.hitEvent(region.rect, e);
      this.invalidate();
      if (wheel)
        region.on.wheel?.(
          e.kind === "wheel-up" ? -WHEEL_ROWS : WHEEL_ROWS,
          hit,
        );
      else region.on.click?.(hit);
      return;
    }
    if (!wheel) return;
    // Nothing claimed the notch: the historical behaviour, which is what a
    // screen with a plain cursor and no scroll pane wants.
    for (let i = 0; i < WHEEL_ROWS; i++)
      this.onKey({
        type: "key",
        key: e.kind === "wheel-up" ? "up" : "down",
        ctrl: false,
        alt: false,
        shift: false,
      });
  }

  private hitEvent(rect: Rect, e: MouseEvent): HitEvent {
    const previous = this.lastClick;
    const same =
      previous !== null &&
      previous.rect.x === rect.x &&
      previous.rect.y === rect.y &&
      previous.rect.w === rect.w &&
      previous.rect.h === rect.h;
    const double = same && Date.now() - previous.at < DOUBLE_MS;
    if (e.kind === "press")
      // A double-click must not chain into a triple: the second press
      // resets the clock rather than extending it.
      this.lastClick = { rect, at: double ? 0 : Date.now() };
    return {
      x: e.x - rect.x,
      y: e.y - rect.y,
      col: e.x,
      row: e.y,
      double,
      button: e.button,
      ctrl: e.ctrl,
      alt: e.alt,
      shift: e.shift,
    };
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
        this.palette.open([...this.commands, ...(this.top().screen.commands?.() ?? [])]);
        this.schedulePaletteSearch();
        return;
      case "appearance":
        this.overlay = "theme";
        this.pickerRow = this.themeIndex;
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
        })
        .finally(() => {
          // The live run is the last; once it lands this query has nothing left to do.
          if (live && this.paletteAbort === abort) this.paletteTimers = [];
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
      else if (result !== null) this.run(result);
      return;
    }
    if (this.overlay === "theme") {
      this.pickerKey(e);
      return;
    }
    this.overlay = "none";
  }

  /** Close the palette and run one of its rows — the click and the Enter. */
  private runPaletteRow(index: number): void {
    const chosen = this.palette.items()[index];
    this.overlay = "none";
    if (chosen !== undefined) this.run(chosen);
  }

  private run(command: Command): void {
    this.overlay = "none";
    void Promise.resolve(command.run()).catch((err: unknown) =>
      this.toast(message(err), "danger"),
    );
  }

  // ---- the appearance picker ----

  /** Rows in the picker: every theme, then graphics, then icons. */
  private get pickerRows(): number {
    return THEME_NAMES.length + 2;
  }

  /**
   * One vertical cursor over three different kinds of choice. A theme row
   * applies as you pass over it — the whole screen repaints, so choosing is
   * looking rather than remembering — while the two setting rows cycle on
   * left/right/enter, because their values are a short ring, not a list.
   */
  private pickerKey(e: KeyEvent): void {
    const rows = this.pickerRows;
    if (e.key === "down" || e.key === "j")
      this.selectPickerRow((this.pickerRow + 1) % rows);
    else if (e.key === "up" || e.key === "k")
      this.selectPickerRow((this.pickerRow + rows - 1) % rows);
    else if (this.pickerRow >= THEME_NAMES.length) {
      const back = e.key === "left" || e.key === "h";
      if (
        back ||
        e.key === "right" ||
        e.key === "l" ||
        e.key === "enter" ||
        e.key === " "
      )
        this.cyclePreference(
          this.pickerRow - THEME_NAMES.length,
          back ? -1 : 1,
        );
      else if (e.key === "esc" || e.key === "q" || (e.ctrl && e.key === "t"))
        this.overlay = "none";
    } else if (
      e.key === "enter" ||
      e.key === "esc" ||
      (e.ctrl && e.key === "t")
    )
      this.close();
    else if (e.key === "q") this.close();
    this.invalidate();
  }

  private close(): void {
    this.overlay = "none";
    // Only the *choice* is announced, never every frame of the browse.
    this.applyTheme(THEME_NAMES[this.themeIndex] ?? this.themeName, true);
  }

  private selectPickerRow(row: number): void {
    this.pickerRow = row;
    if (row >= THEME_NAMES.length) return;
    this.themeIndex = row;
    this.applyTheme(THEME_NAMES[row] ?? this.themeName, false);
  }

  /** 0 = graphics, 1 = icons. Both persist through the host's `onPrefs`. */
  private cyclePreference(which: number, step: number): void {
    if (which === 0) {
      const at = GRAPHICS_SETTINGS.indexOf(this.graphics);
      const next =
        (at + step + GRAPHICS_SETTINGS.length) % GRAPHICS_SETTINGS.length;
      this.graphics = GRAPHICS_SETTINGS[next] ?? "auto";
    } else {
      const at = ICON_SETTINGS.indexOf(this.iconSetting);
      const next = (at + step + ICON_SETTINGS.length) % ICON_SETTINGS.length;
      this.iconSetting = ICON_SETTINGS[next] ?? "auto";
    }
    this.capabilities = this.readCapabilities();
    // A graphics change can strand a placement drawn under the old protocol.
    this.imagesStale = true;
    this.opts.onPrefs?.({ graphics: this.graphics, icons: this.iconSetting });
    this.invalidate();
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
    // The hit table stands for the pixels that are about to be drawn, so it
    // is emptied here and rebuilt by whoever draws. A region can never
    // outlive its frame, which is the bug every retained hit table has.
    this.regions = [];
    this.wanted = null;

    const c = theme(this.themeName).c;
    const s = this.surface;
    // The whole screen is painted in the theme's background: a TUI that lets
    // the user's own background show through looks like six half-themes.
    s.clear(style(c.fg, c.bg));

    // Below the floor no layout survives — a card is narrower than its title
    // and the help bar shows one key — so one line says what would help,
    // and the screens keep their state for the moment the window grows.
    if (s.cols < MIN_COLS || s.rows < MIN_ROWS) {
      s.line(
        s.rect(),
        Math.floor(s.rows / 2),
        truncate(
          `Resize your terminal to ${MIN_COLS}×${MIN_ROWS} or more`,
          s.cols,
        ),
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
    if (this.overlay !== "none") {
      // Everything under an overlay stops being clickable, and clicking the
      // dimmed part is how you dismiss it — the gesture people already have
      // for a modal. Registered before the overlay's own rows, so those win.
      this.ctx.hit(s.rect(), () => {
        this.overlay = "none";
      });
    }
    if (this.overlay === "palette") {
      const drawn = this.palette.render(s, body!, c);
      this.cursor = drawn.cursor;
      for (const row of drawn.rows)
        this.ctx.hit(row.rect, () => this.runPaletteRow(row.index));
    }
    if (this.overlay === "help") this.drawHelp(body!, c);
    if (this.overlay === "theme") this.drawThemes(body!, c);
    this.flush();
    this.flushImage();
  }

  /**
   * Send the picture, or take it away.
   *
   * A placement is only re-sent when it is *new* — a different image, a
   * different rectangle, or a repaint that invalidated the whole screen.
   * `drawImage` reserves its cells with the theme ground, so an ordinary
   * frame emits nothing over them and the pixels underneath survive; re-
   * sending a megabyte of base64 on every keystroke would be the one thing
   * that made images unusable over SSH.
   */
  private flushImage(): void {
    const next = this.wanted;
    const prev = this.placed;
    const same =
      prev !== null &&
      next !== null &&
      prev.id === next.id &&
      prev.rect.x === next.rect.x &&
      prev.rect.y === next.rect.y &&
      prev.rect.w === next.rect.w &&
      prev.rect.h === next.rect.h;
    if (same && !this.imagesStale) return;
    const out: Uint8Array[] = [];
    // Anything already on screen goes first: two placements at overlapping
    // cells is how a "ghost" of the previous file appears behind the new one.
    if (prev !== null) out.push(...clearImages(this.capabilities));
    if (next !== null) out.push(...next.bytes);
    for (const bytes of out) this.opts.terminal.write(bytes);
    this.placed = next;
    this.imagesStale = false;
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
    // A hint in the bar is a *button*: clicking one presses the key it names,
    // which is the shortest possible path from "I can see what this does" to
    // doing it. Disabled hints are drawn and not registered.
    for (const hint of helpBar(s, r, c, bindings)) {
      if (hint.binding.disabled === true) continue;
      const chord = hint.binding.keys[0];
      if (chord === undefined) continue;
      const event = keyFor(chord);
      if (event === undefined) continue;
      this.ctx.hit(hint.rect, () => this.onKey(event));
    }
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
    // The mouse note lives here rather than in the bar because it is the one
    // thing a mouse user cannot discover by clicking: that selecting text
    // now needs Shift, and why.
    const rows: { keys: string; help: string; dim: boolean }[] = [
      ...bindings.map((b) => ({
        keys: truncate(b.keys.join(" / "), 14),
        help: b.help,
        dim: b.disabled === true,
      })),
      { keys: "", help: "", dim: true },
      {
        keys: "click",
        help: "select a row; click it again to open",
        dim: true,
      },
      { keys: "wheel", help: "scroll the list under the pointer", dim: true },
      {
        keys: "shift+drag",
        help: "select text (the terminal's own)",
        dim: true,
      },
    ];
    rows.forEach((b, i) => {
      if (i >= inner.h) return;
      s.text(
        inner.x,
        inner.y + i,
        b.keys,
        style(c.accent, c.card),
        inner.x + inner.w,
      );
      s.text(
        inner.x + 16,
        inner.y + i,
        truncate(b.help, Math.max(0, inner.w - 16)),
        style(b.dim ? c.faint : c.fg, c.card),
        inner.x + inner.w,
      );
    });
  }

  /**
   * Appearance: the theme list, then the two terminal preferences, then a
   * line of real icons in the set that is currently chosen.
   *
   * The preview is the point of the two extra rows. Nerd Font glyphs are a
   * bet on a font `TERM` cannot tell us about, and the only honest way to
   * settle that bet is to show the user three of them and let them look. If
   * they see boxes, one keypress puts it back.
   */
  private drawThemes(area: Rect, c: Tokens): void {
    const s = this.surface;
    const width = Math.min(38, area.w);
    const height = Math.min(this.pickerRows + 4, area.h);
    // Hard against the right edge: two columns of the card underneath
    // peeking out past an overlay reads as a rendering fault, not as depth.
    const r = {
      x: area.x + Math.max(0, area.w - width),
      y: area.y,
      w: width,
      h: height,
    };
    const inner = card(s, r, c, { title: "Appearance", focused: true });
    const set = this.capabilities.icons;
    const line = (
      i: number,
      label: string,
      value: string,
      on: boolean,
    ): void => {
      const y = inner.y + i;
      if (y >= inner.y + inner.h) return;
      const st = style(
        on ? c.fg : c.mutedFg,
        on ? c.muted : c.card,
        on ? BOLD : 0,
      );
      s.fill({ x: inner.x, y, w: inner.w, h: 1 }, " ", st);
      s.text(
        inner.x,
        y,
        `${on ? G.caretRight : " "} ${truncate(label, Math.max(0, inner.w - 2))}`,
        st,
        inner.x + inner.w,
      );
      if (value !== "")
        s.text(
          inner.x + inner.w - value.length,
          y,
          value,
          style(on ? c.accent : c.faint, on ? c.muted : c.card),
          inner.x + inner.w,
        );
      this.ctx.hit({ x: inner.x, y, w: inner.w, h: 1 }, () => {
        // Clicking a setting row that is already current cycles it; clicking
        // any other row selects it. One gesture, two meanings, and the one it
        // means is the one that is obvious from where the cursor already is.
        if (i === this.pickerRow && i >= THEME_NAMES.length)
          this.cyclePreference(i - THEME_NAMES.length, 1);
        else this.selectPickerRow(i);
      });
    };

    THEME_NAMES.forEach((name, i) =>
      line(i, theme(name).label, "", i === this.pickerRow),
    );
    line(
      THEME_NAMES.length,
      "Images",
      graphicsLabel(this.graphics, this.capabilities),
      this.pickerRow === THEME_NAMES.length,
    );
    line(
      THEME_NAMES.length + 1,
      "Icons",
      `${this.iconSetting}${this.iconSetting === "auto" ? ` (${set})` : ""}`,
      this.pickerRow === THEME_NAMES.length + 1,
    );
    const previewY = inner.y + this.pickerRows + 1;
    if (previewY < inner.y + inner.h)
      s.text(
        inner.x,
        previewY,
        truncate(
          `${fileIcon("main.ts", set)} ${icon("issue", set)} ${icon("branch", set)}  ${
            set === "nerd" ? "boxes? pick plain" : "plain glyphs"
          }`,
          inner.w,
        ),
        style(c.mutedFg, c.card),
        inner.x + inner.w,
      );
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

/**
 * "auto (kitty)" rather than "auto": the setting and what it resolved to are
 * two different facts, and a user deciding whether to override a guess needs
 * both. `none` says why it is none, since "your terminal" and "you turned it
 * off" call for different next steps.
 */
function graphicsLabel(
  setting: GraphicsSetting,
  caps: TermCapabilities,
): string {
  if (setting !== "auto") return setting;
  return `auto (${caps.graphics})`;
}
