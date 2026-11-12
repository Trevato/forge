/**
 * YAML and TOML config files as a form (#7337): read into the same document
 * JSON uses, and written back with their comments, anchors and layout intact.
 */

import { describe, expect, test } from "bun:test";
import { formatOf, isFormConfig, languageOf, parseConfig, writeConfig } from "../src/web/render/config-format.ts";
import { configFields } from "../src/web/render/config-form.ts";
import { getAt, updateAt, type Json } from "../src/web/render/json-doc.ts";
import { findSchema, schemaRefusal } from "../src/web/render/json-schema.ts";
import { rendererFor } from "../src/web/render/renderers.ts";
import { config } from "../src/web/render/config.ts";

const read = (path: string, text: string): Json => {
  const p = parseConfig(path, text);
  if (!p.ok) throw new Error(p.error.message);
  return p.value;
};

/** Change the string at `at`, write the file back, and return its new text. */
const edit = (path: string, text: string, at: string, to: Json): string => {
  const before = read(path, text);
  const w = writeConfig(path, text, before, updateAt(before, at, () => to));
  if (!w.ok) throw new Error(w.message);
  return w.text;
};

const YAML = `# service settings
name: forge # the app
base: &base
  retries: 3
  verbose: false
child:
  <<: *base
  url: 'http://x'
tags:
- a
- b # second
servers:
- host: one
  port: 80
- host: two
  port: 81
`;

describe("which files open as a form", () => {
  test("JSON, YAML and TOML do; INI does not", () => {
    expect(["a.json", "a.yml", "a.YAML", "a.toml"].map(formatOf)).toEqual(["json", "yaml", "yaml", "toml"]);
    expect(isFormConfig("a.ini")).toBe(false);
    const body = new TextEncoder().encode("a: 1\n");
    const blob = { kind: "text" as const, size: body.length, body } as never;
    expect(rendererFor("x/a.yml", blob)).toBeDefined();
    expect(rendererFor("x/a.toml", blob)).toBeDefined();
    expect(rendererFor("x/a.ini", blob)).toBeUndefined();
  });
});

describe("YAML", () => {
  test("reads values, aliases as what they point at, in the file's order", () => {
    const doc = read("a.yml", YAML);
    expect(getAt(doc, "/name")).toEqual({ t: "string", v: "forge" });
    expect(getAt(doc, "/child/<</retries")).toEqual({ t: "number", v: "3" });
    expect(getAt(doc, "/servers/1/port")).toEqual({ t: "number", v: "81" });
    expect(doc.t === "object" && doc.entries.map(([k]) => k)).toEqual(["name", "base", "child", "tags", "servers"]);
  });

  test("a file nobody changed is written byte for byte", () => {
    const doc = read("a.yml", YAML);
    expect(writeConfig("a.yml", YAML, doc, doc)).toEqual({ ok: true, text: YAML });
  });

  test("changing one value changes only that line, comments and anchors kept", () => {
    const next = edit("a.yml", YAML, "/servers/0/port", { t: "number", v: "8080" });
    const was = YAML.split("\n");
    const now = next.split("\n");
    expect(now.length).toBe(was.length);
    const differing = now.filter((l, i) => l !== was[i]);
    expect(differing).toEqual(["  port: 8080"]);
    expect(next).toContain("# service settings");
    expect(next).toContain("base: &base");
    expect(next).toContain("<<: *base");
  });

  test("a changed string keeps its quotes and its trailing comment", () => {
    const next = edit("a.yml", YAML, "/name", { t: "string", v: "anvil" });
    expect(next).toContain("name: anvil # the app");
    expect(edit("a.yml", YAML, "/child/url", { t: "string", v: "http://y" })).toContain("url: 'http://y'");
  });

  test("an added and a removed card are written", () => {
    const before = read("a.yml", YAML);
    const added = updateAt(before, "/servers", (s) =>
      s.t === "array"
        ? { t: "array", items: [...s.items, { t: "object", entries: [["host", { t: "string", v: "three" }], ["port", { t: "number", v: "82" }]] }] }
        : s,
    );
    const w = writeConfig("a.yml", YAML, before, added);
    expect(w.ok && w.text).toContain("host: three");
    expect(w.ok && w.text).toContain("# second");
    const removed = updateAt(before, "/servers", (s) => (s.t === "array" ? { t: "array", items: s.items.slice(0, 1) } : s));
    const r = writeConfig("a.yml", YAML, before, removed);
    expect(r.ok && r.text).not.toContain("two");
  });

  test("a file that indents sequences flush is not reflowed", () => {
    // A mixed file cannot be kept (one setting per document); a consistent one is.
    expect(edit("a.yml", YAML, "/name", { t: "string", v: "z" })).toContain("tags:\n- a\n- b # second");
  });

  test("several documents are one fieldset each; only the changed one is rewritten", () => {
    const text = "# one\na: 1\n---\n# two\nb:   2 # odd spacing\n---\nc: 3\n";
    const doc = read("m.yaml", text);
    expect(doc.t === "object" && doc.entries.map(([k]) => k)).toEqual(["Document 1", "Document 2", "Document 3"]);
    const html = String(configFields(doc, {}));
    expect(html.match(/<fieldset/g)?.length).toBeGreaterThanOrEqual(3);
    expect(edit("m.yaml", text, "/Document 1/a", { t: "number", v: "9" })).toBe("# one\na: 9\n---\n# two\nb:   2 # odd spacing\n---\nc: 3\n");
  });

  test("a syntax error names its line", () => {
    const p = parseConfig("a.yml", "a: 1\nb: [1, 2\nc: 3\n");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.line).toBeGreaterThanOrEqual(2);
  });

  test("an alias bomb is refused, not expanded", () => {
    let text = "a0: &a0 [x, x, x, x, x, x, x, x, x]\n";
    for (let i = 1; i < 12; i++) text += `a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(", ")}]\n`;
    expect(parseConfig("bomb.yml", text).ok).toBe(false);
  });

  test("a key that is not text is refused, with the reason", () => {
    const p = parseConfig("a.yml", "1: one\n");
    expect(p.ok).toBe(false);
  });

  test("the schema lookup is JSON's: a sibling <name>.schema.json", async () => {
    const files: Record<string, string> = { "deploy/app.schema.json": '{"properties":{"name":{"description":"The app"}}}' };
    const found = await findSchema("deploy/app.yml", read("deploy/app.yml", "name: x\n"), async (p) => files[p]);
    expect(found?.from).toBe("deploy/app.schema.json");
  });

  test("the blob page draws the form, and says so for a broken file", () => {
    const input = (text: string) => {
      const body = new TextEncoder().encode(text);
      return { path: "a.yml", size: body.length, body, media: "/o/r/media/main/a.yml", download: "/o/r/raw/main/a.yml" };
    };
    expect(String(config(input(YAML)).content)).toContain("config-form");
    expect(String(config(input("a: [1\n")).content)).toContain("Not valid YAML");
  });
});

const TOML = `# top comment
title = "forge" # inline

[server]
# the port
port = 80
since = 1979-05-27T07:32:00Z

[[servers]]
host = "one"

[[servers]]
host = "two"
`;

describe("TOML", () => {
  test("a table is a fieldset and an array of tables is cards", () => {
    const html = String(configFields(read("a.toml", TOML), {}));
    expect(html).toContain("<fieldset");
    expect(html).toContain("config-card");
    expect(html.match(/config-card/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("dates show as the text they were written as", () => {
    expect(getAt(read("a.toml", TOML), "/server/since")).toEqual({ t: "string", v: "1979-05-27T07:32:00Z" });
  });

  test("an untouched file is written as it was; a change touches only its line", () => {
    const doc = read("a.toml", TOML);
    expect(writeConfig("a.toml", TOML, doc, doc)).toEqual({ ok: true, text: TOML });
    const next = edit("a.toml", TOML, "/server/port", { t: "number", v: "8080" });
    expect(next).toBe(TOML.replace("port = 80", "port = 8080"));
  });

  test("a date stays a date when its text is edited", () => {
    const next = edit("a.toml", TOML, "/server/since", { t: "string", v: "1980-01-01T00:00:00Z" });
    expect(next).toContain("since = 1980-01-01T00:00:00Z");
  });

  test("adding and removing a card keeps the comments", () => {
    const before = read("a.toml", TOML);
    const card = (host: string): Json => ({ t: "object", entries: [["host", { t: "string", v: host }]] });
    const grown = updateAt(before, "/servers", () => ({ t: "array", items: [card("one"), card("two"), card("three")] }));
    const w = writeConfig("a.toml", TOML, before, grown);
    expect(w.ok && w.text).toContain('host = "three"');
    expect(w.ok && w.text).toContain("# the port");
    const shrunk = updateAt(before, "/servers", () => ({ t: "array", items: [card("two")] }));
    const s = writeConfig("a.toml", TOML, before, shrunk);
    expect(s.ok && s.text).not.toContain('"one"');
    expect(s.ok && s.text).toContain("# top comment");
  });

  test("TOML cannot hold null, and says so", () => {
    const before = read("a.toml", TOML);
    const w = writeConfig("a.toml", TOML, before, updateAt(before, "/title", () => ({ t: "null" })));
    expect(w.ok).toBe(false);
  });

  test("a syntax error names its line", () => {
    const p = parseConfig("a.toml", "a = 1\nb = \nc = 2\n");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.line).toBe(3);
  });
});

describe("hostile input is bounded, whatever the language", () => {
  // Parsing only ever sees text under MAX_FORM_BYTES: the page and the submit path both check the size first.
  test("deeply nested flow collections, merge keys and TOML arrays are refused, not walked", () => {
    expect(parseConfig("a.yml", `a: ${"[".repeat(10_000)}${"]".repeat(10_000)}\n`).ok).toBe(false);
    let merge = "a0: &a0 {x: 1}\n";
    for (let i = 1; i <= 11; i++) merge += `a${i}: &a${i}\n  <<: [${Array(9).fill(`*a${i - 1}`).join(", ")}]\n`;
    expect(parseConfig("m.yml", merge).ok).toBe(false);
    expect(parseConfig("a.toml", `a = ${"[".repeat(65)}${"]".repeat(65)}\n`).ok).toBe(false);
    expect(parseConfig("a.toml", `a = ${"[".repeat(20)}${"]".repeat(20)}\n`).ok).toBe(true);
  });
});

describe("the terminal checks YAML and TOML against a schema, as the page does", () => {
  const SCHEMA = JSON.stringify({ type: "object", properties: { port: { type: "number" } }, required: ["port"] });
  const files: Record<string, string> = { "svc.schema.json": SCHEMA };
  const readFile = async (p: string): Promise<string | undefined> => files[p];

  test("a file that breaks the sibling schema is refused; one that keeps it is not", async () => {
    expect(await schemaRefusal("svc.yml", "port: x\n", readFile)).toContain("svc.yml breaks");
    expect(await schemaRefusal("svc.toml", 'port = "x"\n', readFile)).toContain("svc.toml breaks");
    expect(await schemaRefusal("svc.yml", "port: 80\n", readFile)).toBeUndefined();
    expect(await schemaRefusal("svc.toml", "port = 80\n", readFile)).toBeUndefined();
    expect(await schemaRefusal("svc.ini", "port=x\n", readFile)).toBeUndefined();
  });
});

test("the language is named in one place", () => {
  expect([languageOf("a.json"), languageOf("a.yaml"), languageOf("a.toml"), languageOf("a.txt")]).toEqual(["JSON", "YAML", "TOML", "JSON"]);
});

describe("the vendored bundles say what they are", () => {
  const dir = new URL("../src/web/render/vendor/", import.meta.url);
  const text = (name: string): Promise<string> => Bun.file(new URL(name, dir)).text();

  test("each bundle names its pinned version and its licence file, and the licence is there", async () => {
    const yaml = await text("yaml.mjs");
    const toml = await text("toml-patch.mjs");
    const yamlVersion = /^\/\/ yaml (\d+\.\d+\.\d+) /.exec(yaml)?.[1];
    const tomlVersion = /^\/\/ @decimalturn\/toml-patch (\d+\.\d+\.\d+) /.exec(toml)?.[1];
    expect(yamlVersion).toBeDefined();
    expect(tomlVersion).toBeDefined();
    expect(await text("YAML-LICENSE")).toContain("Eemeli Aro");
    expect(await text("TOML-PATCH-LICENSE")).toContain("MIT License");
    // docs/features/config-form.md records the same pins and how to regenerate.
    const doc = await Bun.file(new URL("../../../../docs/features/config-form.md", dir)).text();
    expect(doc).toContain(`yaml ${yamlVersion}`);
    expect(doc).toContain(`toml-patch ${tomlVersion}`);
    // The bundle is the one the page's commands rebuild, byte for byte.
    const sha = (t: string): string => new Bun.CryptoHasher("sha256").update(t).digest("hex");
    expect(doc).toContain(`\`yaml.mjs\` sha256 \`${sha(yaml)}\``);
    expect(doc).toContain(`\`toml-patch.mjs\` sha256 \`${sha(toml)}\``);
  });
});
