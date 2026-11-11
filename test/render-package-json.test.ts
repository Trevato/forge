import { describe, expect, test } from "bun:test";
import { packageJson, parsePackage, ROW_CAP } from "../src/web/render/package-json.ts";
import { fileKind, kindByName } from "../src/web/render/kinds.ts";
import { RENDERERS, rendererFor } from "../src/web/render/renderers.ts";
import { renderBlob } from "../src/web/pages/repo.ts";
import type { RepoScope } from "../src/web/scope.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const draw = (text: string) => {
  const body = enc(text);
  const r = packageJson({ path: "package.json", size: body.length, body, media: "", download: "" });
  return { html: String(r.content), summary: r.summary, fallback: r.fallback };
};
const MANIFEST = JSON.stringify({
  name: "demo", version: "1.2.3", type: "module", engines: { node: ">=20" },
  scripts: { test: "bun test", build: "<script>alert(1)</script>" },
  dependencies: { hono: "^4.0.0" }, devDependencies: { typescript: "~5.4" },
});

describe("package.json", () => {
  test("the registry names exactly package.json", () => {
    expect(fileKind("package.json", enc("{}"))).toBe("package");
    expect(fileKind("apps/web/package.json", enc("{}"))).toBe("package");
    expect(kindByName("package.json")).toBe("package");
    expect(fileKind("package-lock.json", enc("{}"))).toBe("config");
    expect(fileKind("mypackage.json", enc("{}"))).toBe("config");
    expect(RENDERERS.package).toBe(packageJson);
  });
  test("rows for scripts, dependencies with ranges, and the facts line", () => {
    const h = draw(MANIFEST).html;
    expect(h).toContain("demo 1.2.3");
    expect(h).toContain("type module · node &gt;=20");
    expect(h).toContain("<code>test</code></th><td><code>bun test</code>");
    expect(h).toContain("hono");
    expect(h).toContain("^4.0.0");
    expect(h).toContain("Dev dependencies");
    expect(h).toContain("~5.4");
  });
  test("every value is escaped", () => {
    const h = draw(MANIFEST).html;
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(draw('{"name":"<img src=x>"}').html).not.toContain("<img");
  });
  test("malformed JSON, a non-object or an empty manifest keep the source view", () => {
    for (const bad of ["{ nope", "[1]", "{}", '{"description":"x"}']) {
      expect(parsePackage(bad)).toBeUndefined();
      const body = enc(bad);
      expect(rendererFor("package.json", { kind: "text", body, size: body.length } as never)).toBeUndefined();
    }
    const body = enc(MANIFEST);
    expect(rendererFor("package.json", { kind: "text", body, size: body.length } as never)?.render).toBe(packageJson);
    expect(draw(MANIFEST).fallback).toBeUndefined();
  });
  test("a BOM is stripped", () => {
    expect(parsePackage("\uFEFF" + MANIFEST)?.name).toBe("demo");
  });
  test("facts: license and packageManager; peer and optional sections", () => {
    const doc = parsePackage(JSON.stringify({
      name: "x", license: "MIT", packageManager: "bun@1.2.0",
      peerDependencies: { react: "^18 || ~19" }, optionalDependencies: { fsevents: "*" },
    }));
    expect(doc?.facts).toEqual(["MIT", "bun@1.2.0"]);
    const h = draw('{"name":"x","peerDependencies":{"react":"^18 || ~19"},"optionalDependencies":{"fsevents":"*"}}').html;
    expect(h).toContain("Peer dependencies");
    expect(h).toContain("^18 || ~19");
    expect(h).toContain("Optional dependencies");
    expect(h).toContain("fsevents");
  });
  test("ranges and commands are wrapping code inside a scrolling wrapper, not numbers", () => {
    const h = draw(MANIFEST).html;
    expect(h).toContain('<code class="break">^4.0.0</code>');
    expect(h).toContain('class="table-scroll"');
    expect(h).not.toContain('class="num"');
  });
  test("cap per section", () => {
    const deps = Object.fromEntries(Array.from({ length: ROW_CAP + 3 }, (_, i) => [`p${i}`, "1"]));
    expect(draw(JSON.stringify({ dependencies: deps })).html).toContain("3 more not shown");
  });
});

describe("package.json on the blob page", () => {
  const scope = { base: "/o/r", facts: { name: "r" }, caps: { write: false }, kind: "local" } as unknown as RepoScope;
  const page = (text: string) => {
    const body = enc(text);
    return String(renderBlob(scope, { refs: { branches: ["main"], tags: [] }, ref: "main", path: "package.json", blob: { kind: "text", body, size: body.length } }));
  };
  test("a malformed manifest is its source, with no banner and no Rendered tab", () => {
    for (const bad of ['{ "name": "x",', "{}"]) {
      const h = page(bad);
      expect(h).not.toContain("Showing the source");
      expect(h).not.toContain("package-view");
      expect(h).not.toMatch(/>\s*Rendered\s*</);
      expect(h).toContain('id="L1"');
    }
  });
  test("a manifest is drawn, Rendered current", () => {
    const h = page(MANIFEST);
    expect(h).toContain("package-view");
    expect(h).toMatch(/<[^>]*aria-current[^>]*>\s*Rendered/);
  });
});
