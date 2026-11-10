import { describe, expect, test } from "bun:test";
import { envView, looksSecret, parseEnv, ROW_CAP } from "../src/web/render/env.ts";
import { fileKind, isEnvExample, NO_BYTES } from "../src/web/render/kinds.ts";
import { rendererFor } from "../src/web/render/renderers.ts";

const draw = (text: string, path = ".env.example"): { html: string; summary: string | undefined; fallback: string | undefined } => {
  const body = new TextEncoder().encode(text);
  const r = envView({ path, size: body.length, body, media: "", download: "" });
  return { html: String(r.content), summary: r.summary, fallback: r.fallback };
};

describe("parseEnv", () => {
  test("quotes, export and inline comments", () => {
    const { rows } = parseEnv(
      ['A="hello world" # quoted', "export B='x # not a comment'", "C=plain # note", 'D="a\\"b"', "E=", "F=http://x/#frag"].join("\n"),
    );
    expect(rows.map((r) => [r.name, r.value, r.comment])).toEqual([
      ["A", "hello world", "quoted"],
      ["B", "x # not a comment", ""],
      ["C", "plain", "note"],
      ["D", 'a"b', ""],
      ["E", "", ""],
      ["F", "http://x/#frag", ""],
    ]);
  });
  test("comment above a line, and blank-separated groups", () => {
    const { rows } = parseEnv("# Database\n\n# The url\n# of it\nDB=pg\n\n# Mail\n\nSMTP=x\n");
    expect(rows[0]).toMatchObject({ name: "DB", comment: "The url of it", group: "Database" });
    expect(rows[1]).toMatchObject({ name: "SMTP", group: "Mail" });
  });
});

describe("masking", () => {
  test("by name, even in an example", () => {
    expect(looksSecret("API_KEY")).toBe(true);
    expect(looksSecret("CLIENT_SECRET")).toBe(true);
    expect(looksSecret("GH_TOKEN")).toBe(true);
    expect(looksSecret("DB_PASSWORD_HASH")).toBe(true);
    expect(looksSecret("PORT")).toBe(false);
    const out = draw("API_KEY=sk-live-123\nDB_PASSWORD=hunter2\nPORT=3000\nEMPTY_TOKEN=\n").html;
    expect(out).toContain("•••");
    expect(out).not.toContain("sk-live-123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("3000");
  });
});

describe("drawing", () => {
  test("empty cells are a dash; groups are headings", () => {
    const out = draw("# Web\n\nPORT=\n").html;
    expect(out).toContain('<th scope="rowgroup" colspan="3">Web</th>');
    expect(out).toContain("<td>—</td><td>—</td>");
  });
  test("every cell is escaped", () => {
    const out = draw('# <b>x</b>\n\nA="<script>alert(1)</script>" # <img src=x onerror=1>\n').html;
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;");
  });
  test("the cap says how many are left", () => {
    const text = Array.from({ length: ROW_CAP + 7 }, (_, i) => `V${i}=1`).join("\n");
    const r = draw(text);
    expect(r.html).toContain("7 more not shown");
    expect(r.html).not.toContain("V510");
    expect(r.summary).toContain("507 variables");
  });
  test("a file with no variables falls back to source", () => {
    expect(draw("# nothing\n").fallback).toBeDefined();
  });
});

describe("which files", () => {
  test("only the three example names", () => {
    for (const n of [".env.example", ".env.sample", ".env.template", "app/.env.example"]) {
      expect(isEnvExample(n)).toBe(true);
      expect(fileKind(n, NO_BYTES)).toBe("env");
    }
    for (const n of [".env", ".env.local", "env.example", ".env.production", "a.env.example"]) {
      expect(isEnvExample(n)).toBe(false);
      expect(fileKind(n, NO_BYTES)).not.toBe("env");
    }
  });
  test("a plain .env keeps the source view; an example gets a renderer", () => {
    const body = new TextEncoder().encode("A=1\n");
    const blob = { kind: "text", body, size: body.length } as never;
    expect(rendererFor(".env", blob)).toBeUndefined();
    expect(rendererFor(".env.example", blob)).toBeDefined();
  });
});
