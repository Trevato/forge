import { afterEach, describe, expect, test } from "bun:test";
import { cell, createOut } from "../src/cli/out.ts";
import { displayWidth } from "../src/tui/term/width.ts";

const ESC = "\x1b";
const saved = {
  noColor: process.env["NO_COLOR"],
  forgeColor: process.env["FORGE_COLOR"],
  isTTY: process.stdout.isTTY,
  columns: process.stdout.columns,
};

function terminal(tty: boolean, columns?: number): void {
  Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("NO_COLOR", saved.noColor);
  restore("FORGE_COLOR", saved.forgeColor);
  terminal(saved.isTTY as boolean, saved.columns);
});

function capture(): { out: ReturnType<typeof createOut>; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = createOut((t) => void stdout.push(t), (t) => void stderr.push(t));
  return { out, stdout, stderr };
}

describe("colour", () => {
  test("piped output carries no ANSI escape", () => {
    delete process.env["NO_COLOR"];
    delete process.env["FORGE_COLOR"];
    terminal(false);
    const { out, stdout } = capture();
    out.line(out.paint("hello", 0xff0000));
    out.table([{ header: "name" }], [[cell("a", 0x00ff00, 1)]]);
    expect(out.color).toBe(false);
    expect(stdout.join("")).not.toContain(ESC);
  });

  test("NO_COLOR silences a terminal", () => {
    process.env["NO_COLOR"] = "1";
    terminal(true, 100);
    const { out } = capture();
    expect(out.color).toBe(false);
    expect(out.paint("x", 0xff0000)).toBe("x");
  });

  test("a terminal without NO_COLOR paints", () => {
    delete process.env["NO_COLOR"];
    delete process.env["FORGE_COLOR"];
    terminal(true, 100);
    const { out } = capture();
    expect(out.color).toBe(true);
    const painted = out.paint("x", 0xff0000);
    expect(painted).toContain(ESC);
    expect(painted.endsWith(`${ESC}[0m`)).toBe(true);
  });
});

describe("streams and width", () => {
  test("width is 80 without a terminal, the terminal's otherwise", () => {
    terminal(false, undefined);
    expect(capture().out.width).toBe(80);
    terminal(true, 132);
    expect(capture().out.width).toBe(132);
  });

  test("err goes to stderr, line to stdout", () => {
    terminal(false);
    const { out, stdout, stderr } = capture();
    out.err("bad");
    out.line("good");
    expect(stderr).toEqual(["bad\n"]);
    expect(stdout).toEqual(["good\n"]);
  });
});

describe("table", () => {
  function render(
    cols: Parameters<ReturnType<typeof createOut>["table"]>[0],
    rows: Parameters<ReturnType<typeof createOut>["table"]>[1],
  ): string[] {
    terminal(false);
    const { out, stdout } = capture();
    out.table(cols, rows);
    return stdout.join("").split("\n").filter((l) => l !== "");
  }

  test("a column with CJK and emoji lines up with ASCII", () => {
    const lines = render(
      [{ header: "repo" }, { header: "n" }],
      [[cell("plain"), cell("1")], [cell("日本語"), cell("2")], [cell("🔥x"), cell("3")]],
    );
    const start = lines.map((l) => displayWidth(l.slice(0, l.lastIndexOf("  "))));
    expect(new Set(start).size).toBe(1);
    expect(start[0]).toBe(displayWidth("日本語") > 5 ? 6 : 5);
    expect(lines.map((l) => l.at(-1))).toEqual(["n", "1", "2", "3"]);
  });

  test("max cuts a cell", () => {
    const lines = render([{ header: "name", max: 5 }], [[cell("abcdefghij")]]);
    expect(lines[1]).toBe("abcd…");
    expect(displayWidth(lines[1]!)).toBe(5);
  });

  test("right-aligned numbers end at the same column", () => {
    const lines = render(
      [{ header: "n", align: "right" }, { header: "x" }],
      [[cell("1"), cell("a")], [cell("1234"), cell("b")], [cell("56"), cell("c")]],
    );
    const ends = lines.map((l) => l.lastIndexOf("  "));
    expect(new Set(ends).size).toBe(1);
    expect(lines[1]).toBe("   1  a");
  });

  test("an escape sequence in a cell is printed inert", () => {
    const lines = render(
      [{ header: "repo" }],
      [[cell(`evil${ESC}[2J${ESC}]0;pwned\x07name`)]],
    );
    const text = lines.join("\n");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\x07");
  });
});
