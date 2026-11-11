import { describe, expect, test } from "bun:test";
import { makefile, parseMakefile, ROW_CAP } from "../src/web/render/makefile.ts";
import { fileKind, kindByName } from "../src/web/render/kinds.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const draw = (text: string) => {
  const body = enc(text);
  const r = makefile({ path: "Makefile", size: body.length, body, media: "", download: "" });
  return { html: String(r.content), summary: r.summary, fallback: r.fallback };
};
const targets = (text: string) => parseMakefile(text).items.flatMap((i) => (i.kind === "target" ? [i.target] : []));

describe("makefile kind", () => {
  test("by name", () => {
    for (const p of ["Makefile", "makefile", "GNUmakefile", "a/b/rules.mk", "x/Makefile"]) {
      expect(fileKind(p, enc("all:\n"))).toBe("makefile");
      expect(kindByName(p)).toBe("makefile");
    }
    expect(fileKind("Makefile.txt", enc("x"))).toBe("text");
    expect(fileKind("notmakefile.c", enc("x"))).toBe("text");
  });
});

describe("parseMakefile", () => {
  test("targets, prerequisites, order-only and recipe", () => {
    const [t] = targets("app: a.o b.o | dir\n\tcc -o app a.o b.o\n\t@echo done\n");
    expect(t).toMatchObject({ names: "app", prereqs: ["a.o", "b.o"], orderOnly: ["dir"], recipe: ["cc -o app a.o b.o", "@echo done"], phony: false });
  });
  test("phony, even when declared after the target", () => {
    const ts = targets("test:\n\tbun test\nbuild:\n\tx\n.PHONY: test\n");
    expect(ts.map((t) => [t.names, t.phony])).toEqual([["test", true], ["build", false]]);
  });
  test("variables", () => {
    const doc = parseMakefile("CC := gcc\nFLAGS ?= -O2 -Wall\nexport PATH += :/x\n");
    expect(doc.variables).toBe(3);
    expect(doc.items.map((i) => (i.kind === "variable" ? [i.variable.name, i.variable.op, i.variable.value] : null))).toEqual([
      ["CC", ":=", "gcc"],
      ["FLAGS", "?=", "-O2 -Wall"],
      ["PATH", "+=", ":/x"],
    ]);
  });
  test("continuation lines join in prerequisites and stay in a recipe", () => {
    const [t] = targets("all: a \\\n  b \\\n  c\n\techo one \\\n\t  two\n\techo three\n");
    expect(t!.prereqs).toEqual(["a", "b", "c"]);
    expect(t!.recipe).toEqual(["echo one \\\n\t  two", "echo three"]);
  });
  test("an inline recipe after ;", () => {
    expect(targets("a: b ; echo hi\n")[0]!.recipe).toEqual(["echo hi"]);
  });
  test("what it does not understand stays as source, in place", () => {
    const doc = parseMakefile("include foo.mk\nifeq ($(A),1)\nX=1\nendif\ndefine T\n\tbody: not a rule\nendef\n\torphan\nall: CC=gcc\n");
    expect(doc.targets).toBe(0);
    expect(doc.items.filter((i) => i.kind === "source").map((i) => (i as { text: string }).text)).toEqual([
      "include foo.mk",
      "ifeq ($(A),1)",
      "endif",
      "define T",
      "\tbody: not a rule",
      "endef",
      "\torphan",
      "all: CC=gcc",
    ]);
  });
  test("comments stay as notes", () => {
    expect(parseMakefile("# build it\nall:\n").items[0]).toEqual({ kind: "comment", text: "build it" });
  });
});

describe("makefile view", () => {
  test("draws variables on top, targets after, phony marked", () => {
    const { html, summary } = draw(".PHONY: clean\nCC = gcc\nall: a.o\n\t$(CC) a.o\nclean:\n\trm a.o\n");
    expect(html.indexOf("Variables")).toBeLessThan(html.indexOf("Targets"));
    expect(html).toContain("<code>clean</code> <span class=\"badge\">phony</span>");
    expect(html).not.toContain("<code>all</code> <span");
    expect(summary).toContain("2 targets · 1 variable");
  });
  test("the .PHONY line is not repeated as a row", () => {
    const { html } = draw(".PHONY: clean\nclean:\n\trm a.o\n");
    expect(html).not.toContain(".PHONY");
    expect(parseMakefile(".PHONY: a\n").items).toEqual([]);
  });
  test("each table scrolls on its own, so the page never does", () => {
    const { html } = draw("CC = gcc\nall:\n\tx\n");
    expect(html.match(/<div class="table-scroll" role="region" tabindex="0"/g)?.length).toBe(2);
  });
  test("escapes every value", () => {
    const { html } = draw("X = <img src=x onerror=1>\n<b>t</b>: <i>p</i>\n\t<script>1</script>\n# <u>c</u>\ninclude <s>.mk\n");
    expect(html).not.toMatch(/<(img|b|i|script|u|s)[ >]/);
    expect(html).toContain("&lt;script&gt;");
  });
  test("empty file falls back", () => {
    expect(draw("\n\n").fallback).toBeDefined();
  });
  test("caps the rows and says so", () => {
    const { html } = draw(Array.from({ length: ROW_CAP + 3 }, (_, i) => `t${i}:\n`).join(""));
    expect(html).toContain("3 more not shown");
  });
});
