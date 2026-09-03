import { describe, expect, test } from "bun:test";
import {
  InputDecoder,
  parse,
  type InputEvent,
  type KeyEvent,
} from "../src/tui/term/input.ts";

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);

/** Feed the whole string as one chunk and settle anything left pending. */
function decode(s: string): InputEvent[] {
  const d = new InputDecoder();
  const out = [...d.push(bytes(s))];
  out.push(...d.flush());
  return out;
}

function keys(s: string): string[] {
  return decode(s).map(show);
}

function showKey(e: KeyEvent): string {
  return `${e.ctrl ? "ctrl+" : ""}${e.alt ? "alt+" : ""}${e.shift ? "shift+" : ""}${e.key}`;
}

function show(e: InputEvent): string {
  if (e.type === "key") return showKey(e);
  if (e.type === "paste") return `paste:${e.text}`;
  if (e.type === "mouse") return `${e.kind}@${e.x},${e.y}`;
  return `resize:${e.cols}x${e.rows}`;
}

describe("plain bytes", () => {
  test("printable, enter, tab, backspace, ctrl", () => {
    expect(keys("abc")).toEqual(["a", "b", "c"]);
    expect(keys("\r")).toEqual(["enter"]);
    expect(keys("\n")).toEqual(["enter"]); // raw mode clears ICRNL
    expect(keys("\t")).toEqual(["tab"]);
    expect(keys("\x7f")).toEqual(["backspace"]);
    expect(keys("\x08")).toEqual(["backspace"]); // stty erase ^H
    expect(keys("\x03")).toEqual(["ctrl+c"]);
    expect(keys("\x04")).toEqual(["ctrl+d"]);
    expect(keys("\x17")).toEqual(["ctrl+w"]);
    expect(keys("\x00")).toEqual(["ctrl+space"]);
  });
});

describe("CSI and SS3", () => {
  test("arrows in both DECCKM forms", () => {
    expect(keys("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
    expect(keys("\x1bOA\x1bOB\x1bOC\x1bOD")).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
  });

  test("home/end/editing keypad/function keys", () => {
    expect(keys("\x1b[H\x1b[F\x1bOH\x1bOF")).toEqual([
      "home",
      "end",
      "home",
      "end",
    ]);
    expect(keys("\x1b[2~\x1b[3~\x1b[5~\x1b[6~")).toEqual([
      "insert",
      "delete",
      "pgup",
      "pgdn",
    ]);
    expect(keys("\x1b[1~\x1b[4~\x1b[7~\x1b[8~")).toEqual([
      "home",
      "end",
      "home",
      "end",
    ]);
    expect(keys("\x1bOP\x1bOQ\x1bOR\x1bOS")).toEqual(["f1", "f2", "f3", "f4"]);
    expect(keys("\x1b[11~\x1b[15~\x1b[17~\x1b[24~")).toEqual([
      "f1",
      "f5",
      "f6",
      "f12",
    ]);
    expect(keys("\x1b[Z")).toEqual(["shift+tab"]);
  });

  test("modifiers are 1 + bitmask", () => {
    expect(keys("\x1b[1;5C")).toEqual(["ctrl+right"]);
    expect(keys("\x1b[1;4A")).toEqual(["alt+shift+up"]);
    expect(keys("\x1b[3;5~")).toEqual(["ctrl+delete"]);
    expect(keys("\x1b[15;2~")).toEqual(["shift+f5"]);
    // F1–F4 switch from SS3 to CSI the moment they are modified.
    expect(keys("\x1b[1;5P")).toEqual(["ctrl+f1"]);
  });

  test("focus events are recognised and dropped", () => {
    expect(keys("\x1b[I\x1b[Oa")).toEqual(["a"]);
  });
});

describe("ESC vs Alt", () => {
  test("a lone ESC in a chunk is Escape once the idle timer fires", () => {
    const d = new InputDecoder();
    expect(d.push(bytes("\x1b"))).toEqual([]); // still ambiguous
    expect(d.pending).toBe(1);
    expect(d.flush().map(show)).toEqual(["esc"]);
  });

  test("ESC arriving with its key in the same read is Alt", () => {
    const d = new InputDecoder();
    expect(d.push(bytes("\x1bb")).map(show)).toEqual(["alt+b"]);
    expect(d.pending).toBe(0);
  });

  test("ESC then a later key is Escape then the key", () => {
    const d = new InputDecoder();
    expect(d.push(bytes("\x1b"))).toEqual([]);
    expect(d.flush().map(show)).toEqual(["esc"]);
    expect(d.push(bytes("b")).map(show)).toEqual(["b"]);
  });

  test("alt+enter and alt+backspace", () => {
    expect(keys("\x1b\r")).toEqual(["alt+enter"]);
    expect(keys("\x1b\x7f")).toEqual(["alt+backspace"]);
  });
});

describe("chunk boundaries", () => {
  const cases = [
    { name: "2-byte UTF-8", input: "é", want: ["é"] },
    { name: "3-byte UTF-8", input: "漢", want: ["漢"] },
    { name: "4-byte UTF-8", input: "\u{1F600}", want: ["\u{1F600}"] },
    { name: "CSI arrow", input: "\x1b[A", want: ["up"] },
    { name: "modified CSI", input: "\x1b[1;5C", want: ["ctrl+right"] },
    { name: "SS3", input: "\x1bOP", want: ["f1"] },
    { name: "SGR mouse", input: "\x1b[<64;10;5M", want: ["wheel-up@9,4"] },
    {
      name: "paste",
      input: "\x1b[200~hi there\x1b[201~",
      want: ["paste:hi there"],
    },
  ];

  for (const c of cases) {
    test(`${c.name} survives every split`, () => {
      const raw = bytes(c.input);
      for (let cut = 0; cut <= raw.length; cut++) {
        const d = new InputDecoder();
        const got: InputEvent[] = [
          ...d.push(raw.subarray(0, cut)),
          ...d.push(raw.subarray(cut)),
          ...d.flush(),
        ];
        expect(got.map(show)).toEqual(c.want);
      }
    });
  }

  test("byte-at-a-time delivery of a whole session", () => {
    const raw = bytes("ab\x1b[A漢\x1b[1;5C\x1b[200~x\x1b[201~\r");
    const d = new InputDecoder();
    const got: InputEvent[] = [];
    for (const b of raw) got.push(...d.push(Uint8Array.of(b)));
    got.push(...d.flush());
    expect(got.map(show)).toEqual([
      "a",
      "b",
      "up",
      "漢",
      "ctrl+right",
      "paste:x",
      "enter",
    ]);
  });
});

describe("bracketed paste", () => {
  test("content is opaque data, never keys or escapes", () => {
    // A hostile clipboard embedding CSI and control bytes must not be able to
    // steer the app; only the first end marker terminates the paste.
    const hostile = "\x1b[200~a\x1b[31mb\x07c\x1b[201~\x1b[201~d";
    expect(keys(hostile)).toEqual(["paste:a[31mbc", "d"]);
  });

  test("newlines survive, CRLF is normalised", () => {
    expect(keys("\x1b[200~a\r\nb\x1b[201~")).toEqual(["paste:a\nb"]);
  });

  test("multi-byte content is consumed by byte length, not code units", () => {
    expect(keys("\x1b[200~漢字\x1b[201~z")).toEqual(["paste:漢字", "z"]);
  });
});

describe("mouse", () => {
  test("wheel notches carry their direction and cell", () => {
    expect(keys("\x1b[<64;1;1M")).toEqual(["wheel-up@0,0"]);
    expect(keys("\x1b[<65;80;24M")).toEqual(["wheel-down@79,23"]);
    expect(keys("\x1b[<80;3;3M")[0]).toBe("wheel-up@2,2"); // ctrl+wheel
    // A wheel "release" is not a thing; 1006 sends `m` for one anyway.
    expect(keys("\x1b[<64;1;1m")).toEqual([]);
  });

  test("a press and its release are both reported", () => {
    expect(keys("\x1b[<0;5;5M\x1b[<0;5;5m")).toEqual([
      "press@4,4",
      "release@4,4",
    ]);
    expect(keys("\x1b[<2;1;1M")).toEqual(["press@0,0"]); // right button
  });

  test("the button byte is a bitfield, not a number", () => {
    // +16 is ctrl, and reading it as an integer would make this button 16.
    const [event] = decode("\x1b[<16;5;5M");
    expect(event).toMatchObject({ kind: "press", button: 0, ctrl: true });
    // +32 is motion: consumed, never carried up. A drag has nothing to drag.
    expect(keys("\x1b[<32;5;6M")).toEqual([]);
    expect(keys("\x1b[<35;9;9M")).toEqual([]);
  });
});

describe("the parser contract", () => {
  test("n === 0 means need more bytes and consumes nothing", () => {
    expect(parse(bytes("\x1b["), 0, false)).toEqual({ event: null, n: 0 });
    expect(parse(bytes("\x1b[1;"), 0, false)).toEqual({ event: null, n: 0 });
    // A lone UTF-8 lead byte: wait for its continuation, do not error.
    expect(parse(Uint8Array.of(0xc3), 0, false)).toEqual({ event: null, n: 0 });
    expect(parse(new Uint8Array(0), 0, true)).toEqual({ event: null, n: 0 });
  });

  test("a malformed sequence resyncs instead of clearing the buffer", () => {
    // The stray control byte ends the CSI; the following "a" still arrives.
    expect(keys("\x1b[1\x01a")).toEqual(["ctrl+a", "a"]);
    // A control byte inside a CSI ends it; parsing resumes on that byte.
    expect(keys("\x1b[\x07a")).toEqual(["ctrl+g", "a"]);
  });
});
