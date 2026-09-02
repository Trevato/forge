import { describe, expect, test } from "bun:test";
import { Renderer } from "../src/tui/term/render.ts";
import { Screen, box } from "../src/tui/term/screen.ts";
import {
  BOLD,
  DIM,
  ITALIC,
  REVERSE,
  UNDERLINE,
  PLAIN,
  quantize256,
  sgrDelta,
  style,
} from "../src/tui/term/style.ts";
import {
  VirtualTerminal,
  diffScreens,
  headlessTerminal,
  TerminalSession,
} from "../src/tui/term/terminal.ts";
import { THEME_NAMES } from "../src/design/themes.ts";
import { theme } from "../src/tui/ui/theme.ts";

/** A tiny deterministic PRNG so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const GLYPHS = ["a", "b", " ", "漢", "字", "│", "─", "é", "\u{1F600}", "x"];

function paintRandom(s: Screen, next: () => number): void {
  const colors = [-1, 0x000000, 0xff0000, 0x2563eb, 0xfafafa, 0x18181b];
  const attrs = [0, BOLD, DIM, ITALIC, UNDERLINE, REVERSE, BOLD | UNDERLINE];
  const count = Math.floor(next() * s.cols * s.rows);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(next() * s.cols);
    const y = Math.floor(next() * s.rows);
    const g = GLYPHS[Math.floor(next() * GLYPHS.length)]!;
    s.set(
      x,
      y,
      g,
      style(
        colors[Math.floor(next() * colors.length)]!,
        colors[Math.floor(next() * colors.length)]!,
        attrs[Math.floor(next() * attrs.length)]!,
      ),
    );
  }
}

describe("the diff renderer", () => {
  test("a virtual terminal replaying our bytes reproduces the buffer", () => {
    const next = rng(20260901);
    for (let trial = 0; trial < 40; trial++) {
      const cols = 20 + Math.floor(next() * 60);
      const rows = 6 + Math.floor(next() * 20);
      const renderer = new Renderer("truecolor");
      const vt = new VirtualTerminal(cols, rows);
      const s = new Screen(cols, rows);
      for (let frame = 0; frame < 5; frame++) {
        s.clear(style(0xf4f4f5, 0x09090b));
        paintRandom(s, next);
        vt.consume(renderer.render(s, null));
        const bad = diffScreens(s, vt.screen);
        expect(bad).toBeNull();
      }
    }
  });

  test("a no-op frame emits zero bytes", () => {
    const r = new Renderer("truecolor");
    const s = new Screen(20, 5);
    s.clear(style(0xffffff, 0x000000));
    s.text(2, 2, "hello", style(0xff0000, 0x000000));
    expect(r.render(s, null).length).toBeGreaterThan(0);
    expect(r.render(s, null)).toBe("");
  });

  test("an incremental frame is far smaller than a full repaint", () => {
    const r = new Renderer("truecolor");
    const s = new Screen(80, 24);
    s.clear(style(0xf4f4f5, 0x09090b));
    const full = r.render(s, null).length;
    s.text(0, 0, "x", style(0xff0000, 0x09090b));
    const patch = r.render(s, null);
    expect(patch.length).toBeLessThan(full / 10);
    expect(patch).toContain("\x1b[?2026h"); // synchronized output, always
    expect(patch).toContain("\x1b[?2026l");
  });

  test("a resize forces a full repaint and never diffs across sizes", () => {
    const r = new Renderer("truecolor");
    const a = new Screen(30, 8);
    a.clear(style(0xffffff, 0x101010));
    a.text(1, 1, "before", style(0xffffff, 0x101010));
    const vt1 = new VirtualTerminal(30, 8);
    vt1.consume(r.render(a, null));
    expect(diffScreens(a, vt1.screen)).toBeNull();

    const b = new Screen(50, 12);
    b.clear(style(0xffffff, 0x101010));
    b.text(3, 3, "after", style(0xffffff, 0x101010));
    r.invalidate();
    const out = r.render(b, null);
    expect(out).toContain("\x1b[2J");
    const vt2 = new VirtualTerminal(50, 12);
    vt2.consume(out);
    expect(diffScreens(b, vt2.screen)).toBeNull();
  });

  test("a wide styled glyph replaced by a narrow one clears both columns", () => {
    // Ratatui's #2585/#2587: skipping the uncovered trailing column leaves a
    // stale background that looks like a terminal bug.
    const r = new Renderer("truecolor");
    const vt = new VirtualTerminal(10, 2);
    const s = new Screen(10, 2);
    s.clear(PLAIN);
    s.set(2, 0, "漢", style(0xffffff, 0xff0000));
    vt.consume(r.render(s, null));
    expect(diffScreens(s, vt.screen)).toBeNull();

    s.clear(PLAIN);
    s.set(2, 0, "a", style(0xffffff, -1));
    vt.consume(r.render(s, null));
    expect(diffScreens(s, vt.screen)).toBeNull();
    expect(vt.screen.styleAt(3, 0).bg).toBe(-1);
  });

  test("a wide glyph is never split at the right edge", () => {
    const s = new Screen(5, 1);
    s.clear(PLAIN);
    expect(s.set(4, 0, "漢", PLAIN)).toBe(1); // substituted with a space
    expect(s.textAt(4, 0)).toBe(" ");
    expect(s.text(0, 0, "a漢字", PLAIN)).toBe(5);
    expect(s.toText()).toBe("a漢字");
  });

  test("the cursor is placed and shown only for a focused field", () => {
    const r = new Renderer("truecolor");
    const s = new Screen(10, 3);
    s.clear(PLAIN);
    expect(r.render(s, null)).toContain("\x1b[?25l");
    const out = r.render(s, { x: 4, y: 2 });
    expect(out).toContain("\x1b[3;5H\x1b[?25h");
  });
});

describe("SGR emission", () => {
  test("only deltas are emitted", () => {
    const a = style(0xff0000, 0x000000, BOLD);
    expect(sgrDelta(a, a, "truecolor")).toBe("");
    expect(sgrDelta(PLAIN, a, "truecolor")).toBe(
      "\x1b[38;2;255;0;0;48;2;0;0;0;1m",
    );
    // The semicolon form, never the colon form: older VTE, tmux and Apple
    // Terminal mishandle `38:2::r:g:b`.
    expect(sgrDelta(PLAIN, a, "truecolor")).not.toContain(":");
  });

  test("SGR 22 kills bold and dim together, so the survivor is re-applied", () => {
    const both = style(-1, -1, BOLD | DIM);
    const dimOnly = style(-1, -1, DIM);
    expect(sgrDelta(both, dimOnly, "truecolor")).toBe("\x1b[22;2m");
    expect(sgrDelta(both, style(-1, -1, 0), "truecolor")).toBe("\x1b[22m");
  });

  test("turn-offs are emitted for every attribute", () => {
    const on = style(-1, -1, ITALIC | UNDERLINE | REVERSE);
    expect(sgrDelta(on, PLAIN, "truecolor")).toBe("\x1b[23;24;27m");
  });
});

describe("256-colour quantization", () => {
  test("cube and ramp anchors round-trip", () => {
    expect(quantize256(0x000000)).toBe(16);
    expect(quantize256(0xffffff)).toBe(231);
    expect(quantize256(0xff0000)).toBe(196);
    expect(quantize256(0x0000ff)).toBe(21);
    // The grey ramp must win for a near-grey — chalk's exact-equality
    // shortcut sends this through the cube and misses a much closer grey.
    expect(quantize256(0x808182)).toBe(244);
  });

  test("every colour in every theme quantizes to a near neighbour", () => {
    const cube = [0, 95, 135, 175, 215, 255];
    const back = (i: number): [number, number, number] => {
      if (i >= 232) {
        const v = 8 + 10 * (i - 232);
        return [v, v, v];
      }
      const n = i - 16;
      return [
        cube[Math.floor(n / 36)]!,
        cube[Math.floor(n / 6) % 6]!,
        cube[n % 6]!,
      ];
    };
    for (const name of THEME_NAMES) {
      const t = theme(name).c;
      for (const [key, value] of Object.entries(t)) {
        if (typeof value !== "number") continue;
        const [r, g, b] = back(quantize256(value));
        const d =
          Math.abs(r - ((value >> 16) & 0xff)) +
          Math.abs(g - ((value >> 8) & 0xff)) +
          Math.abs(b - (value & 0xff));
        // The cube's first step is 95 wide, so a single channel can be off by
        // ~47; 90 across three channels is a tight bound that still proves
        // nothing lands in a wildly wrong bucket.
        expect(`${name}.${key}:${d}`).toBe(
          `${name}.${key}:${d <= 90 ? d : "TOO FAR"}`,
        );
      }
    }
  });

  test("the 256 path emits indexed colours, not truecolor", () => {
    const out = sgrDelta(PLAIN, style(0x2563eb, 0x09090b), "256");
    expect(out).toMatch(/^\x1b\[38;5;\d+;48;5;\d+m$/);
  });
});

describe("session lifecycle", () => {
  test("enter and leave emit their sequences in the order that matters", () => {
    const t = headlessTerminal(20, 5);
    const session = new TerminalSession(t, { mouse: true });
    session.enter();
    const enter = t.takeOutput();
    expect(enter).toContain("\x1b[?1049h"); // alt screen
    expect(enter).toContain("\x1b[?2004h"); // bracketed paste
    expect(enter.indexOf("\x1b[?1000h")).toBeLessThan(
      enter.indexOf("\x1b[?1006h"),
    ); // SGR coordinates enabled last

    session.leave();
    const leave = t.takeOutput();
    // SGR reset BEFORE leaving the alt screen, or attributes leak into the
    // primary buffer and corrupt the user's shell prompt.
    expect(leave.indexOf("\x1b[0m")).toBeLessThan(leave.indexOf("\x1b[?1049l"));
    expect(leave.indexOf("\x1b[?1006l")).toBeLessThan(
      leave.indexOf("\x1b[?1000l"),
    ); // disabled in reverse order
    expect(leave).toContain("\x1b[?2004l");
    expect(leave).toContain("\x1b[?25h");
    expect(leave).toContain("\x1b[?7h");
    expect(t.closed).toBe(true);

    session.leave(); // idempotent: every exit path may call it
    expect(t.takeOutput()).toBe("");
  });

  test("text written outside the frame loop uses CRLF", () => {
    const t = headlessTerminal(20, 5);
    const session = new TerminalSession(t);
    session.print("bye\n");
    expect(t.output()).toBe("bye\r\n");
  });
});

describe("the cell buffer", () => {
  test("box returns its interior and draws a hairline frame", () => {
    const s = new Screen(12, 4);
    s.clear(PLAIN);
    const inner = box(
      s,
      { x: 0, y: 0, w: 12, h: 4 },
      {
        style: PLAIN,
        title: "hi",
      },
    );
    expect(inner).toEqual({ x: 1, y: 1, w: 10, h: 2 });
    expect(s.toText().split("\n")[0]).toBe("╭─ hi ─────╮");
  });

  test("overlapping a wide glyph obliterates both of its columns", () => {
    const s = new Screen(6, 1);
    s.clear(PLAIN);
    s.set(1, 0, "漢", PLAIN);
    s.set(2, 0, "x", PLAIN); // lands on the trailing column
    expect(s.toText()).toBe("  x"); // the lead half is blanked, not halved
  });
});
