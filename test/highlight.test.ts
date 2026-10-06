/**
 * The tokenizer, which both surfaces render through — the web's spans and the
 * terminal's colours come from these exact tokens, so a bug here is a bug in
 * two products.
 *
 * Three properties are load-bearing and are asserted for every language:
 *
 *   **lossless** — the token texts of a line concatenate back to the line, so
 *   nothing a file contains can be dropped or duplicated on the way to a page;
 *   **linear** — scanning a line eight times longer takes about eight times
 *   as long, never sixty-four, which is what lets the editor re-highlight a
 *   long line on every keystroke;
 *   **total** — random bytes in any language never throw.
 *
 * On top of that, one fixture per language, snapshotted, so a change to a rule
 * table shows up as a diff of what it actually paints rather than as a hunch.
 */

import { describe, expect, test } from "bun:test";
import {
  detectLanguage,
  highlightLines,
  INITIAL_SCAN,
  languageFromFirstLine,
  languageFromName,
  LANGUAGES,
  scanOneLine,
  type Language,
  type Token,
} from "../src/web/highlight.ts";
import { renderTokens, tokenClasses } from "../src/web/highlight-html.ts";
import { THEMES, THEME_NAMES } from "../src/design/themes.ts";
import { css } from "../src/web/style.ts";

/**
 * How `work`'s cost grows with its input, as the exponent k in time ∝ size^k:
 * timed at `small` and at `GROWTH` times that, in this run on this machine,
 * small and large interleaved so load lands on both, best of three each.
 *
 * Linearity is asserted as this exponent, never as milliseconds. A wall-clock
 * bound is a claim about the machine (10ms passed on one box and took 25ms on
 * a crew machine, #294); a ratio cancels the machine out. A linear scanner
 * measures k ≈ 1 (a little above under GC and allocation as the token array
 * grows), a quadratic one k ≈ 2 — the regression these tests exist for — so
 * `LINEAR_BOUND` sits halfway. Growth is 16× rather than 2× so the two are
 * 64× against 256× in time, far apart enough for a loaded machine's noise
 * not to bridge them. A spike can still land on one measurement, so an
 * exponent over the bound is measured again, up to three times, and the best
 * is returned: noise does not repeat, quadratic does.
 */
const GROWTH = 16;
const LINEAR_BOUND = 1.5;

function growth(work: (size: number) => void, small: number): number {
  const time = (size: number) => {
    const t0 = process.cpuUsage();
    work(size);
    const { user, system } = process.cpuUsage(t0);
    return user + system;
  };
  work(small); // warm the JIT so no sample pays for compiling
  let k = Infinity;
  for (let attempt = 0; attempt < 3 && k >= LINEAR_BOUND; attempt++) {
    let lo = Infinity;
    let hi = Infinity;
    for (let i = 0; i < 3; i++) {
      lo = Math.min(lo, time(small));
      hi = Math.min(hi, time(small * GROWTH));
    }
    k = Math.min(k, Math.log(Math.max(hi, 1) / Math.max(lo, 1)) / Math.log(GROWTH));
  }
  return k;
}

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

/** Every token of a fixture, in a form a snapshot diff stays readable in. */
function sketch(code: string, lang: Language): string {
  return highlightLines(code, lang)
    .map((line) =>
      line
        .map((t) => `${t.cls}${t.kind ? `/${t.kind}` : ""}:${t.text}`)
        .join(" | "),
    )
    .join("\n");
}

/** The first token whose text is exactly `text`. */
function tokenFor(code: string, lang: Language, text: string): Token {
  for (const line of highlightLines(code, lang))
    for (const t of line) if (t.text === text) return t;
  throw new Error(`no token ${JSON.stringify(text)} in ${lang}`);
}

// ---- one small fixture per language ----

const FIXTURES: Record<string, string> = {
  ts: `import { html } from "./html.ts";

/** The lamp. */
@sealed
export class Lamp<T> extends Device {
  #lit = false;
  static readonly MAX = 0xff;
  toggle(on: boolean): \`lamp:\${string}\` {
    const re = /^lamp:[a-z]+$/gi;
    return re.test(this.name) ? \`lamp:\${this.name}\` : "lamp:none";
  }
}
const el = <Card title="Lamp" count={2} onClick={() => toggle(!on)} />;
`,
  python: `import os


@dataclass
class Point:
    """A point.

    Spanning lines.
    """

    x: int = 0

    def dist(self, other: "Point") -> float:
        return (self.x - other.x) ** 2  # squared
`,
  go: `package main

import "fmt"

type Beacon struct {
	Name string
	lit  bool
}

func (b *Beacon) Light() error {
	if !b.lit {
		return fmt.Errorf("dark: %q", b.Name)
	}
	return nil
}
`,
  rust: `#[derive(Debug, Clone)]
pub struct Beacon<'a> {
    name: &'a str,
}

impl<'a> Beacon<'a> {
    pub fn new(name: &'a str) -> Self {
        println!("made {}", name);
        Self { name }
    }
}
`,
  c: `#include <stdio.h>
#define MAX 128

/* a block
   comment */
int main(int argc, char **argv) {
    const char *name = "world";
    printf("hello %s\\n", name);
    return 0;
}
`,
  java: `package forge;

@Service
public final class Beacon implements Light {
    private static final int MAX = 128;

    @Override
    public String toString() {
        return "beacon:" + MAX;
    }
}
`,
  kotlin: `package forge

data class Beacon(val name: String, var lit: Boolean = false) {
    fun light(): String {
        if (!lit) return "dark"
        return "lit: $name"
    }
}
`,
  swift: `import Foundation

@MainActor
struct Beacon {
    let name: String
    var lit = false

    func describe() -> String {
        guard lit else { return "dark" }
        return "lit"
    }
}
`,
  ruby: `# frozen_string_literal: true
require "json"

class Beacon
  attr_reader :name

  def initialize(name)
    @name = name
    @lit = false
  end

  def lit?
    @lit && !name.empty?
  end
end
`,
  php: `<?php

namespace Forge;

class Beacon
{
    private string $name;

    public function __construct(string $name)
    {
        $this->name = $name; // remember it
    }
}
`,
  lua: `-- a lamp
local M = {}

function M.light(name)
  if name == nil then
    return "dark"
  end
  return string.format("lit: %s", name)
end

return M
`,
  zig: `const std = @import("std");

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("hello\\n", .{});
}
`,
  elixir: `defmodule Beacon do
  @moduledoc "A beacon."

  def light(name) when is_binary(name) do
    {:ok, "lit: #{name}"}
  end

  def light(_), do: :error
end
`,
  nix: `{ pkgs ? import <nixpkgs> { } }:

pkgs.mkDerivation rec {
  pname = "forge";
  version = "0.1.0";
  buildInputs = [ pkgs.bun ];
}
`,
  json: `{
  "name": "forge",
  "private": true,
  "scripts": { "test": "bun test" },
  "count": 42,
  "nested": [true, false, null]
}
`,
  yaml: `# a workflow
name: ci
on:
  push:
    branches: [main]
anchors: &defaults
  shell: bash
jobs:
  test:
    <<: *defaults
    steps:
      - run: |
          bun install
          bun test
    timeout: 15
    verbose: no
`,
  toml: `# Cargo
[package]
name = "forge"
version = "0.1.0"
edition = 2024

[[bin]]
path = "src/main.rs"
features = ["a", "b"]
`,
  ini: `; a config
[core]
editor = vim
autocrlf = false

[remote "origin"]
url = https://example.test/x.git
`,
  markdown: `# Forge

A **self-hosted** forge with \`zero\` dependencies.

- one
- [ ] a task

> A quote with *emphasis*.

\`\`\`ts
const lamp: string = "lit"; // a fence
\`\`\`

| col | col |
| --- | --- |
| 1   | 2   |

See [the docs](https://example.test/docs).
`,
  css: `/* the shell */
:root {
  --fg: #18181b;
}

.card > a:hover,
#main {
  color: var(--fg);
  margin: 0 8px 1.5rem;
  background: #fff url("x.png") no-repeat !important;
}

@media (min-width: 40rem) {
  .card {
    display: grid;
  }
}
`,
  html: `<!doctype html>
<html lang="en">
  <!-- a note -->
  <body class="page" data-theme>
    <p>Hello &amp; welcome</p>
    <script>
      const x = 1; // inline
    </script>
    <style>
      .a {
        color: red;
      }
    </style>
  </body>
</html>
`,
  shell: `#!/usr/bin/env bash
set -euo pipefail

NAME="\${1:-world}" # default

if [ -f "$HOME/.zshrc" ]; then
  echo "hi $NAME" | tr a-z A-Z
fi

cat <<-EOF
  raw $text here
EOF
`,
  sql: `-- every repo with issues
SELECT r.id, COUNT(i.id) AS n
FROM repos r
LEFT JOIN issues i ON i.repo_id = r.id
WHERE r.visibility = 'public'
GROUP BY r.id
LIMIT 10;
`,
  dockerfile: `# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json ./
RUN bun install --frozen-lockfile
ENV NODE_ENV="production"
CMD ["bun", "run", "src/main.ts"]
`,
  makefile: `# build
CC := clang
FLAGS = -O2

.PHONY: all test

all: build test
	bun run src/main.ts $(FLAGS)

test:
	bun test
`,
  diff: `diff --git a/src/lamp.ts b/src/lamp.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/lamp.ts
+++ b/src/lamp.ts
@@ -1,4 +1,4 @@
 export const lamp = {
-  on() { return "dark" },
+  on() { return "lit" },
 };
`,
};

// ---- detection ----

describe("detectLanguage", () => {
  test("maps extensions", () => {
    expect(detectLanguage("src/a.ts")).toBe("ts");
    expect(detectLanguage("a.tsx")).toBe("ts");
    expect(detectLanguage("m.py")).toBe("python");
    expect(detectLanguage("main.go")).toBe("go");
    expect(detectLanguage("lib.rs")).toBe("rust");
    expect(detectLanguage("data.json")).toBe("json");
    expect(detectLanguage("tsconfig.jsonc")).toBe("json");
    expect(detectLanguage("README.md")).toBe("markdown");
    expect(detectLanguage("style.scss")).toBe("css");
    expect(detectLanguage("page.html")).toBe("html");
    expect(detectLanguage("Config.toml")).toBe("toml");
    expect(detectLanguage("a/b/c.patch")).toBe("diff");
    expect(detectLanguage("view.mm")).toBe("c");
    expect(detectLanguage("noext")).toBe("plain");
  });

  test("maps whole filenames, extension or not", () => {
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("deploy/Dockerfile.prod")).toBe("dockerfile");
    expect(detectLanguage("Makefile")).toBe("makefile");
    expect(detectLanguage("Gemfile")).toBe("ruby");
    expect(detectLanguage(".zshrc")).toBe("shell");
    expect(detectLanguage("Cargo.lock")).toBe("toml");
  });

  test("falls back to a shebang or a modeline", () => {
    expect(detectLanguage("script", "#!/usr/bin/env python3")).toBe("python");
    expect(detectLanguage("script", "#!/bin/bash")).toBe("shell");
    expect(detectLanguage("script", "#!/usr/bin/env node")).toBe("ts");
    expect(detectLanguage("script", "#!/usr/bin/env ruby")).toBe("ruby");
    expect(detectLanguage("notes", "# vim: set ft=yaml:")).toBe("yaml");
    expect(detectLanguage("notes", "-*- mode: python -*-")).toBe("python");
    // The extension always wins: a modeline cannot relabel a .ts file.
    expect(detectLanguage("a.ts", "#!/bin/bash")).toBe("ts");
    expect(languageFromFirstLine("nothing to see")).toBe("plain");
  });

  test("fence info strings name languages the same way", () => {
    expect(languageFromName("ts")).toBe("ts");
    expect(languageFromName("javascript")).toBe("ts");
    expect(languageFromName("c++")).toBe("c");
    expect(languageFromName("shell-script")).toBe("shell");
    expect(languageFromName("yml")).toBe("yaml");
    expect(languageFromName("")).toBe("plain");
    expect(languageFromName("brainfuck")).toBe("plain");
  });
});

// ---- the three properties, for every language ----

describe("every language is lossless", () => {
  for (const [lang, source] of Object.entries(FIXTURES)) {
    test(lang, () => {
      expect(join(source, lang as Language)).toBe(source);
    });
  }

  test("blank lines, no trailing newline, CRLF debris", () => {
    for (const lang of LANGUAGES) {
      for (const sample of ["", "\n", "\n\n  \n", "x", "a\r\nb", "\t\t"]) {
        expect(join(sample, lang)).toBe(sample);
      }
    }
  });
});

describe("every language snapshots", () => {
  for (const [lang, source] of Object.entries(FIXTURES)) {
    test(lang, () => {
      expect(sketch(source, lang as Language)).toMatchSnapshot();
    });
  }
});

describe("resilience", () => {
  test("the growth measure tells linear from quadratic", () => {
    // The yardstick, checked against itself: a scanner that re-reads the
    // line for every character must land above the bound, or the two tests
    // below could never fail.
    const quadratic = (size: number) => {
      const line = "x".repeat(size);
      let sum = 0;
      for (let i = 0; i < size; i++)
        for (let j = i; j < size; j++) sum += line.charCodeAt(j);
      return sum;
    };
    expect(growth(quadratic, 250)).toBeGreaterThan(LINEAR_BOUND);
  }, 30_000);

  test("a long line scans in linear time in every language", () => {
    const unit =
      "const x = { a: 1, b: `t${y}`, c: /re/g, d: 'str', e: [1,2,3] }; // n ";
    const line = (size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    for (const lang of LANGUAGES) {
      expect(highlightLines(line(10_000), lang).length).toBe(1);
      const k = growth((size) => highlightLines(line(size), lang), 500);
      expect({ lang, linear: k < LINEAR_BOUND }).toEqual({ lang, linear: true });
    }
  }, 30_000);

  test("pathological delimiter runs stay linear", () => {
    for (const [unit, label] of [
      ["`", "backticks"],
      ["/", "slashes"],
      ["${", "interpolations"],
      ["<", "angles"],
      ['"', "quotes"],
      ["#[", "attributes"],
      ["[[", "long brackets"],
    ] as const) {
      const junk = (size: number) => unit.repeat(size / unit.length);
      for (const lang of LANGUAGES) expect(join(junk(4_000), lang)).toBe(junk(4_000));
      const k = growth((size) => {
        const text = junk(size);
        for (const lang of LANGUAGES) highlightLines(text, lang);
      }, 250);
      expect({ label, linear: k < LINEAR_BOUND }).toEqual({ label, linear: true });
    }
  }, 30_000);

  test("random bytes never throw, in any language", () => {
    // Deterministic: a seeded generator, so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 400; i++) {
      let sample = "";
      const len = 1 + Math.floor(next() * 90);
      for (let k = 0; k < len; k++)
        sample += String.fromCharCode(Math.floor(next() * 320));
      for (const lang of LANGUAGES) {
        expect(() => highlightLines(sample, lang)).not.toThrow();
        expect(join(sample, lang)).toBe(sample);
      }
    }
  });

  test("an unknown language is one plain token per line", () => {
    const code = "anything <here>\n& there";
    expect(join(code, "plain")).toBe(code);
    expect(highlightLines(code, "plain")[0]).toEqual([
      { cls: "plain", text: "anything <here>" },
    ]);
  });
});

// ---- what the colours actually say ----

describe("classification", () => {
  test("typescript: keywords, types, calls, template literals", () => {
    const c = classesOn(
      "const greet = (name: string) => count.toFixed(2);",
      "ts",
      0,
    );
    expect(c["const"]).toBe("keyword");
    expect(c["string"]).toBe("type");
    expect(c["toFixed"]).toBe("function");
    // The code inside `${…}` is code, not string.
    const line = highlightLines("const t = `hi ${name}!`;", "ts")[0]!;
    expect(line.some((t) => t.cls === "string" && t.text === "`hi ")).toBe(
      true,
    );
    expect(line.some((t) => t.cls === "plain" && t.text === "name")).toBe(true);
  });

  test("typescript: a regex literal is not a division", () => {
    expect(tokenFor("const re = /a+b/gi;", "ts", "/a+b/gi").kind).toBe("regex");
    const divided = highlightLines("const half = total / 2;", "ts")[0]!;
    expect(divided.some((t) => t.kind === "regex")).toBe(false);
    expect(divided.some((t) => t.cls === "operator" && t.text === "/")).toBe(
      true,
    );
  });

  test("typescript: decorators, JSX tags and attributes", () => {
    expect(tokenFor("@sealed\nclass A {}", "ts", "@sealed").kind).toBe(
      "decorator",
    );
    const jsx = 'const el = <Card title="x" onClick={go} />;';
    expect(tokenFor(jsx, "ts", "Card").kind).toBe("tag");
    expect(tokenFor(jsx, "ts", "title").kind).toBe("attribute");
    expect(tokenFor(jsx, "ts", '"x"').cls).toBe("string");
  });

  test("python: def, decorator, docstring", () => {
    const line = highlightLines("def add(a, b):  # sum", "python")[0]!;
    expect(line.find((t) => t.text === "def")?.cls).toBe("keyword");
    expect(line.find((t) => t.text === "add")?.cls).toBe("function");
    expect(
      line.some((t) => t.cls === "comment" && t.text.includes("# sum")),
    ).toBe(true);
    expect(tokenFor("@cache\ndef f(): pass", "python", "@cache").kind).toBe(
      "decorator",
    );
  });

  test("rust: lifetimes are not characters, macros are macros", () => {
    expect(tokenFor("fn f<'a>(x: &'a str) {}", "rust", "'a").kind).toBe(
      "variable",
    );
    expect(tokenFor('println!("x");', "rust", "println!").cls).toBe("function");
    expect(
      tokenFor("#[derive(Debug)]\nstruct A;", "rust", "#[derive(Debug)]").kind,
    ).toBe("decorator");
    // A real character literal still is one.
    expect(tokenFor("let c = 'x';", "rust", "'x'").cls).toBe("string");
  });

  test("json constants and numbers", () => {
    const c = classesOn('{"ok": true, "n": 42}', "json", 0);
    expect(c["true"]).toBe("constant");
    expect(c["42"]).toBe("number");
  });

  test("yaml: keys, anchors, block scalars", () => {
    expect(tokenFor("name: forge", "yaml", "name").kind).toBe("property");
    expect(tokenFor("base: &anchor", "yaml", "&anchor").kind).toBe("variable");
    const scalar = highlightLines(
      "script: |\n  echo one\n  echo two\nnext: 1",
      "yaml",
    );
    expect(scalar[1]!.every((t) => t.cls === "string")).toBe(true);
    expect(scalar[2]!.every((t) => t.cls === "string")).toBe(true);
    // The block ends where the indentation does.
    expect(scalar[3]!.some((t) => t.kind === "property")).toBe(true);
  });

  test("toml and ini: tables and keys", () => {
    expect(tokenFor("[package]", "toml", "[package]").kind).toBe("heading");
    expect(tokenFor('name = "forge"', "toml", "name").kind).toBe("property");
    expect(tokenFor("; note", "ini", "; note").cls).toBe("comment");
  });

  test("markdown: headings, emphasis, links, fences with an inner language", () => {
    expect(tokenFor("# Title", "markdown", "# Title").kind).toBe("heading");
    expect(tokenFor("a **b** c", "markdown", "**b**").kind).toBe("emphasis");
    expect(tokenFor("[t](https://x.test)", "markdown", "t").kind).toBe("link");
    expect(tokenFor("`code`", "markdown", "`code`").cls).toBe("string");
    const fenced = highlightLines(
      "```ts\nconst x = 1;\n```\nafter",
      "markdown",
    );
    expect(
      fenced[1]!.some((t) => t.cls === "keyword" && t.text === "const"),
    ).toBe(true);
    // …and the fence closes, so what follows is prose again.
    expect(fenced[3]!.every((t) => t.cls === "plain")).toBe(true);
  });

  test("css: selectors, properties, values, units, variables", () => {
    expect(tokenFor(".card { color: red }", "css", ".card").cls).toBe(
      "function",
    );
    expect(tokenFor(".card { color: red }", "css", "color").kind).toBe(
      "property",
    );
    expect(tokenFor(".a { margin: 1.5rem }", "css", "1.5rem").cls).toBe(
      "number",
    );
    expect(tokenFor(".a { color: var(--fg) }", "css", "--fg").kind).toBe(
      "variable",
    );
    expect(tokenFor("$brand: red;", "css", "$brand").kind).toBe("variable");
  });

  test("html: tags, attributes, entities, embedded script and style", () => {
    expect(tokenFor('<p class="x">hi</p>', "html", "p").kind).toBe("tag");
    expect(tokenFor('<p class="x">hi</p>', "html", "class").kind).toBe(
      "attribute",
    );
    expect(tokenFor("a &amp; b", "html", "&amp;").cls).toBe("constant");
    const embedded = highlightLines(
      "<script>\nconst x = 1;\n</script>",
      "html",
    );
    expect(
      embedded[1]!.some((t) => t.cls === "keyword" && t.text === "const"),
    ).toBe(true);
    expect(embedded[2]!.some((t) => t.kind === "tag")).toBe(true);
  });

  test("shell: commands, flags, variables in strings, heredocs", () => {
    expect(tokenFor("echo hi", "shell", "echo").cls).toBe("function");
    expect(tokenFor("ls --all", "shell", "--all").kind).toBe("attribute");
    expect(tokenFor('echo "hi $NAME"', "shell", "$NAME").kind).toBe("variable");
    const here = highlightLines("cat <<EOF\nraw text\nEOF\ndone", "shell");
    expect(here[1]!.every((t) => t.cls === "string")).toBe(true);
    expect(here[2]!.some((t) => t.cls === "meta")).toBe(true);
    expect(here[3]!.some((t) => t.cls === "keyword")).toBe(true);
  });

  test("sql keywords are case-insensitive", () => {
    expect(classesOn("SELECT * FROM repos", "sql", 0)["SELECT"]).toBe(
      "keyword",
    );
    expect(classesOn("select * from repos", "sql", 0)["select"]).toBe(
      "keyword",
    );
  });

  test("dockerfile instructions, makefile targets, diff signs", () => {
    expect(tokenFor("FROM bun:1", "dockerfile", "FROM").cls).toBe("keyword");
    expect(tokenFor("all: build", "makefile", "all").cls).toBe("function");
    expect(tokenFor("CC = clang", "makefile", "CC").kind).toBe("property");
    expect(tokenFor("+added", "diff", "+added").kind).toBe("inserted");
    expect(tokenFor("-gone", "diff", "-gone").kind).toBe("deleted");
  });
});

describe("multi-line constructs span lines", () => {
  test("a block comment highlights on every line", () => {
    const lines = highlightLines("code;\n/* one\n two\n three */ more;", "ts");
    expect(lines[1]!.every((t) => t.cls === "comment")).toBe(true);
    expect(lines[2]!.every((t) => t.cls === "comment")).toBe(true);
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

  test("a python docstring closes on its own terms", () => {
    const lines = highlightLines('x = 1\n"""doc\nmore"""\ny = 2', "python");
    expect(lines[1]!.every((t) => t.cls === "string")).toBe(true);
    expect(lines[3]!.some((t) => t.cls === "number" && t.text === "2")).toBe(
      true,
    );
  });

  test("scanOneLine resumes exactly where the previous line left off", () => {
    // The editor's contract: state in, state out, one line at a time.
    const source = ["/* open", "still", "*/ done"];
    let state = INITIAL_SCAN;
    const seen: Token[][] = [];
    for (const line of source) {
      const scanned = scanOneLine(line, "ts", state);
      seen.push(scanned.tokens);
      state = scanned.state;
    }
    expect(seen).toEqual(highlightLines(source.join("\n"), "ts"));
    expect(state.block).toBe(false);
  });
});

// ---- the token vocabulary is complete on both sides ----

describe("token vocabulary", () => {
  /** Every (cls, kind) pair the fixtures actually produce. */
  const emitted = new Set<string>();
  for (const [lang, source] of Object.entries(FIXTURES))
    for (const line of highlightLines(source, lang as Language))
      for (const t of line) {
        emitted.add(`tok-${t.cls}`);
        if (t.kind) emitted.add(`tok-${t.kind}`);
      }

  test("every class the fixtures emit has a stylesheet rule", () => {
    for (const name of emitted) {
      if (name === "tok-plain") continue;
      expect(css).toContain(`.${name} {`);
    }
  });

  test("every theme defines every syntax variable the stylesheet uses", () => {
    const used = new Set(
      [...css.matchAll(/var\((--tok-[a-z-]+)\)/g)].map((m) => m[1]!),
    );
    expect(used.size).toBeGreaterThan(15);
    for (const theme of THEME_NAMES) {
      const tokens = THEMES[theme].tokens as Record<string, string>;
      for (const name of used) {
        expect(tokens[name.slice(2)]).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  test("a class attribute keeps the colour and adds the refinement", () => {
    expect(tokenClasses({ cls: "string", text: "x", kind: "regex" })).toBe(
      "tok-string tok-regex",
    );
    expect(tokenClasses({ cls: "plain", text: "x" })).toBe("");
    expect(tokenClasses({ cls: "plain", text: "x", kind: "emphasis" })).toBe(
      "tok-emphasis",
    );
  });

  test("rendered spans escape everything and reproduce the text", () => {
    const html = renderTokens(
      highlightLines('const s = "<script>&";', "ts")[0]!,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html.replace(/<[^>]*>/g, "")).toBe(
      "const s = &quot;&lt;script&gt;&amp;&quot;;",
    );
  });
});
