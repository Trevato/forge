import { describe, expect, test } from "bun:test";
import {
  detectLanguage,
  highlightLines,
  type Language,
} from "../src/web/highlight.ts";

function join(code: string, lang: Language): string {
  return highlightLines(code, lang)
    .map((line) => line.map((t) => t.text).join(""))
    .join("\n");
}
function classesOn(
  code: string,
  lang: Language,
  lineIdx: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of highlightLines(code, lang)[lineIdx]!) {
    if (t.text.trim() !== "") out[t.text] = t.cls;
  }
  return out;
}

describe("detectLanguage", () => {
  test("maps extensions", () => {
    expect(detectLanguage("src/a.ts")).toBe("ts");
    expect(detectLanguage("a.tsx")).toBe("ts");
    expect(detectLanguage("m.py")).toBe("python");
    expect(detectLanguage("main.go")).toBe("go");
    expect(detectLanguage("lib.rs")).toBe("rust");
    expect(detectLanguage("data.json")).toBe("json");
    expect(detectLanguage("Dockerfile")).toBe("shell");
    expect(detectLanguage("README.md")).toBe("plain");
    expect(detectLanguage("noext")).toBe("plain");
  });
});

describe("lossless round-trip", () => {
  const samples: [string, Language][] = [
    ["const x = `a${b}c`;\nlet y = 1;", "ts"],
    ["def f(n):\n    return n * 2  # doubled", "python"],
    ['func main() {\n\tfmt.Println("hi")\n}', "go"],
    ['{"a": 1, "b": [true, null]}', "json"],
    ["\n\n  \n", "ts"],
    ["no trailing newline", "python"],
    ["trailing\n", "go"],
  ];
  for (const [code, lang] of samples) {
    test(`${lang}: ${JSON.stringify(code).slice(0, 24)}`, () => {
      // split("\n") drops nothing; our join must reproduce the source exactly.
      expect(join(code, lang)).toBe(code);
    });
  }
});

describe("classification", () => {
  test("typescript keywords, strings, types, calls", () => {
    const c = classesOn(
      "const greet = (name: string) => `hi ${name}`;",
      "ts",
      0,
    );
    expect(c["const"]).toBe("keyword");
    expect(c["string"]).toBe("type");
    expect(c["`hi ${name}`"]).toBe("string");
  });
  test("python def and comment", () => {
    const line = highlightLines("def add(a, b):  # sum", "python")[0]!;
    expect(line.find((t) => t.text === "def")?.cls).toBe("keyword");
    expect(line.find((t) => t.text === "add")?.cls).toBe("function");
    expect(
      line.some((t) => t.cls === "comment" && t.text.includes("# sum")),
    ).toBe(true);
  });
  test("json constants and numbers", () => {
    const c = classesOn('{"ok": true, "n": 42}', "json", 0);
    expect(c["true"]).toBe("constant");
    expect(c["42"]).toBe("number");
  });
});

describe("multi-line constructs span lines", () => {
  test("a block comment highlights on every line", () => {
    const lines = highlightLines("code;\n/* one\n two\n three */ more;", "ts");
    expect(lines[1]!.every((t) => t.cls === "comment")).toBe(true);
    expect(lines[2]!.every((t) => t.cls === "comment")).toBe(true);
    // The closing line resumes normal tokens after the comment.
    expect(lines[3]!.some((t) => t.cls === "comment")).toBe(true);
    expect(
      lines[3]!.some((t) => t.cls !== "comment" && t.text.includes("more")),
    ).toBe(true);
  });
  test("a template literal spanning lines stays a string", () => {
    const lines = highlightLines("const t = `line1\nline2`;\nnext;", "ts");
    expect(lines[0]!.some((t) => t.cls === "string")).toBe(true);
    expect(lines[1]!.some((t) => t.cls === "string")).toBe(true);
    expect(lines[2]!.some((t) => t.text === "next")).toBe(true);
  });
});

describe("resilience", () => {
  test("a huge single line completes quickly and losslessly", () => {
    const code = "x".repeat(200_000) + ' "unterminated';
    const t0 = Bun.nanoseconds();
    const result = join(code, "ts");
    expect((Bun.nanoseconds() - t0) / 1e6).toBeLessThan(300);
    expect(result).toBe(code);
  });
  test("binary-ish and unmatched delimiters never throw", () => {
    for (const junk of ["\x00\x01\x02", "'''", "/*/*/*", "```", "\\\\\\"]) {
      expect(() => highlightLines(junk, "ts")).not.toThrow();
      expect(join(junk, "ts")).toBe(junk);
    }
  });
  test("unknown language is one plain token per line, lossless", () => {
    const code = "anything <here>\n& there";
    expect(join(code, "plain")).toBe(code);
    expect(highlightLines(code, "plain")[0]).toEqual([
      { cls: "plain", text: "anything <here>" },
    ]);
  });
});
