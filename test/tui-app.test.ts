import { describe, expect, test } from "bun:test";
import { App, type Ctx } from "../src/tui/app/app.ts";
import { binding } from "../src/tui/app/keys.ts";
import { style } from "../src/tui/term/style.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { theme } from "../src/tui/ui/theme.ts";

const c = theme("dark").c;

function boot(cols = 80, rows = 24) {
  const terminal = headlessTerminal(cols, rows);
  const pasted: string[] = [];
  let ctxRef: Ctx | undefined;
  const app = new App({
    terminal,
    theme: "dark",
    root: (ctx) => {
      ctxRef = ctx;
      return {
        title: "Root",
        keys: [binding("x", "do a thing")],
        render(area, s) {
          s.text(area.x, area.y, "root screen", style(c.fg, c.bg));
        },
        key: () => false,
        paste(text) {
          pasted.push(text);
          return true;
        },
      };
    },
  });
  app.start();
  return { app, terminal, pasted, ctx: ctxRef! };
}

describe("the app loop", () => {
  test("a frame paints chrome, body and help bar; a repeat emits nothing", () => {
    const { app, terminal } = boot();
    const text = app.screen.toText().split("\n");
    expect(text[0]!.trim().startsWith("forge")).toBe(true);
    expect(text[1]).toBe("Root");
    expect(text[2]).toBe("root screen");
    expect(text[23]).toContain("do a thing");
    terminal.takeOutput();
    app.frame();
    // Nothing changed, so the diff renderer writes not one byte.
    expect(terminal.takeOutput()).toBe("");
    app.stop();
  });

  test("bytes in become events: a paste arrives whole, not as keystrokes", () => {
    const { app, terminal, pasted } = boot();
    terminal.feed("\x1b[200~two\nlines\x1b[201~");
    expect(pasted).toEqual(["two\nlines"]);
    app.stop();
  });

  test("push runs load under a signal that pop aborts", async () => {
    const { app, ctx } = boot();
    let aborted = false;
    ctx.push({
      title: "Child",
      keys: [],
      render: () => {},
      key: () => false,
      load: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    });
    app.frame();
    expect(app.screen.toText().split("\n")[1]).toBe("Root › Child");
    ctx.pop();
    await Promise.resolve();
    // This is the cancellation Bubble Tea's commands cannot express.
    expect(aborted).toBe(true);
    app.frame();
    expect(app.screen.toText().split("\n")[1]).toBe("Root");
    app.stop();
  });

  test("the theme picker repaints the whole screen live", () => {
    const { app, terminal } = boot();
    // Sample a cell the screen itself never paints, so what changes is the
    // theme's page background rather than the demo text.
    const before = app.screen.styleAt(70, 10).bg;
    terminal.feed("\x14"); // ctrl+t
    terminal.feed("\x1b[B");
    app.frame();
    expect(app.screen.styleAt(70, 10).bg).not.toBe(before);
    app.stop();
  });

  test("a toast takes over the status bar", () => {
    const { app, ctx } = boot();
    ctx.toast("Merged", "success");
    app.frame();
    expect(app.screen.toText().split("\n")[23]).toContain("Merged");
    expect(app.screen.styleAt(0, 23).bg).toBe(c.success);
    app.stop();
  });

  test("resizing reallocates and forces a full repaint", () => {
    const { app, terminal } = boot(80, 24);
    terminal.resize(60, 20);
    app.frame();
    expect(app.screen.cols).toBe(60);
    expect(app.screen.toText().split("\n").length).toBe(20);
    expect(terminal.takeOutput()).toContain("\x1b[2J");
    app.stop();
  });

  test("ctrl+c leaves the terminal exactly as it was found", () => {
    const { terminal } = boot();
    terminal.takeOutput();
    terminal.feed("\x03");
    const out = terminal.takeOutput();
    // SGR reset before leaving the alt screen; cursor restored; transport closed.
    expect(out.indexOf("\x1b[0m")).toBeLessThan(out.indexOf("\x1b[?1049l"));
    expect(out).toContain("\x1b[?25h");
    expect(terminal.closed).toBe(true);
  });

  test("help and the palette are reserved: a screen cannot swallow them", () => {
    const { app, terminal } = boot();
    terminal.feed("?");
    app.frame();
    expect(app.screen.toText()).toContain("Keys");
    // A bare ESC would stay pending until the idle timer; close with `q`,
    // which any overlay accepts.
    terminal.feed("q");
    terminal.feed(":");
    app.frame();
    // The palette is the search box now; its card says so.
    expect(app.screen.toText()).toContain("Search");
    app.stop();
  });
});

describe("the palette's search", () => {
  test("is not settled until its live re-run has landed", async () => {
    const asked: boolean[] = [];
    const app = new App({
      terminal: headlessTerminal(80, 24),
      theme: "dark",
      root: () => ({ title: "Root", keys: [], render() {}, key: () => false }),
      search: () => async (_query, live) => {
        asked.push(live);
        return [];
      },
    });
    app.start();
    try {
      expect(app.paletteSettled).toBe(true);
      const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
      key(":");
      key("a");
      expect(app.paletteSettled).toBe(false);
      await Bun.sleep(200);
      expect(asked).toEqual([false]);
      expect(app.paletteSettled).toBe(false);
      const deadline = Date.now() + 5_000;
      while (!app.paletteSettled && Date.now() < deadline) await Bun.sleep(10);
      expect(asked).toEqual([false, true]);
      expect(app.paletteSettled).toBe(true);
    } finally {
      app.stop();
    }
  });
});
