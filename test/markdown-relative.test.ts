import { describe, expect, test } from "bun:test";
import type { RefSet } from "../src/web/pages/refs.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { clearReadmeCache, readmeFor, renderBlob } from "../src/web/pages/repo.ts";
import type { RepoScope } from "../src/web/scope.ts";

const repo = { base: "/ann/app", ref: "main", dir: "docs" };
const md = (s: string, r = repo): string => String(renderMarkdown(s, r));

describe("relative images and links resolve inside the repository", () => {
  test("an image renders the file at the same ref", () => {
    expect(md("![logo](img/a.png)")).toContain('<img src="/ann/app/media/main/docs/img/a.png" alt="logo" loading="lazy">');
  });
  test("an image from the root directory and a ../ that stays inside", () => {
    expect(md("![x](../pics/b.svg)")).toContain('src="/ann/app/media/main/pics/b.svg"');
    expect(md("![x](a.png)", { ...repo, dir: "" })).toContain('src="/ann/app/media/main/a.png"');
  });
  test("a ../ out of the repository stays inert", () => {
    for (const url of ["../../x.png", "../../../etc/passwd", "a/../../../x.png"]) {
      const out = md(`![alt](${url})`);
      expect(out).not.toContain("<img");
      expect(out).not.toContain("href");
    }
    const link = md("[go](../../x.md)");
    expect(link).not.toContain("<a");
    expect(link).toContain("go");
  });
  test("encoded traversal and backslashes are inert", () => {
    for (const url of ["%2e%2e/%2e%2e/x.png", "..%2f..%2fx.png", "a%5c..%5cx.png", "a%00.png", "%zz.png"]) {
      expect(md(`![a](${url})`)).not.toContain("<img");
    }
  });
  test("an image that is not an image file is not drawn as one", () => {
    expect(md("![a](notes.md)")).not.toContain("<img");
  });
  test("a link to another .md opens it in the file view", () => {
    expect(md("[more](keeping.md)")).toContain('href="/ann/app/blob/main/docs/keeping.md"');
    expect(md("[more](../README.md#top)")).toContain('href="/ann/app/blob/main/README.md#top"');
  });
  test("a directory link opens the tree", () => {
    expect(md("[src](../src/)")).toContain('href="/ann/app/tree/main/src"');
  });
  test("the ref is carried as given, already encoded", () => {
    expect(md("[a](b.md)", { ...repo, ref: "feat%2Fx" })).toContain("/blob/feat%2Fx/docs/b.md");
  });
  test("unsafe schemes stay stripped, anchors and absolute links stay", () => {
    expect(md("[x](javascript:alert(1))")).not.toContain("<a");
    expect(md("[x](//evil.test/a)")).not.toContain("<a");
    expect(md("![x](https://evil.test/a.png)")).not.toContain("<img");
    expect(md("[x](#top)")).toContain('href="#top"');
    expect(md("[x](https://ok.test/)")).toContain('href="https://ok.test/"');
  });
  test("escaping is unchanged", () => {
    const out = md('![<script>](a.png) [<b>](x.md) "q"');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<b>");
  });
  test("without a repository, nothing is rewritten", () => {
    const out = String(renderMarkdown("[a](b.md) ![i](c.png)"));
    expect(out).toContain('href="b.md"');
    expect(out).not.toContain("<img");
  });
  test("the memo does not mix two repositories", () => {
    const a = md("[a](b.md)");
    const b = md("[a](b.md)", { base: "/bob/app", ref: "main", dir: "" });
    expect(a).toContain("/ann/app/blob/main/docs/b.md");
    expect(b).toContain("/bob/app/blob/main/b.md");
  });

  test("an image inside a link is an image inside a link", () => {
    const out = md("[![badge](b.svg)](x.md)");
    expect(out).toContain('<a href="/ann/app/blob/main/docs/x.md" rel="nofollow noopener"><img src="/ann/app/media/main/docs/b.svg" alt="badge" loading="lazy"></a>');
    expect(out).not.toContain("](");
    expect(md("[![b](https://ok.test/b.svg)](https://ok.test/)")).not.toContain("](");
  });
});

describe("the wiring: README card and file view carry the repository", () => {
  const src = (text: string) =>
    ({
      where: { kind: "local", repo: { id: "r1" } },
      blob: async () => ({ ok: true, value: { kind: "text", body: new TextEncoder().encode(text), size: text.length } }),
    }) as never;
  const entry = (oid: string) => ({ mode: "100644", type: "blob", oid, size: 1, name: "README.md" }) as never;
  const text = "![l](img/a.png) [m](more.md)";

  test("the README card resolves against its blob base, in a subdirectory too", async () => {
    clearReadmeCache();
    const root = String(await readmeFor(src(text), "main", [entry("1".repeat(40))], "", "/ann/app/blob/main"));
    expect(root).toContain('src="/ann/app/media/main/img/a.png"');
    expect(root).toContain('href="/ann/app/blob/main/more.md"');
    const sub = String(await readmeFor(src(text), "main", [entry("1".repeat(40))], "docs", "/ann/app/blob/main"));
    expect(sub).toContain('src="/ann/app/media/main/docs/img/a.png"');
  });
  test("the origins browser and a README with no blob base rewrite nothing", async () => {
    clearReadmeCache();
    const origins = String(await readmeFor(src(text), "main", [entry("2".repeat(40))], "", "/origins/x/blob/main"));
    expect(origins).not.toContain("/media/");
    expect(origins).not.toContain("/blob/main/more.md");
    clearReadmeCache();
    const bare = String(await readmeFor(src(text), "main", [entry("3".repeat(40))], ""));
    expect(bare).not.toContain("/media/");
  });
  test("the file view resolves a nested docs/x.md against docs", () => {
    const out = renderBlob({ base: "/ann/app", kind: "local", caps: { write: false }, facts: { name: "app" } } as unknown as RepoScope, {
      refs: { branches: ["main"], tags: [] } as RefSet,
      ref: "main",
      path: "docs/x.md",
      blob: { kind: "text" as const, body: new TextEncoder().encode("![l](img/a.png) [m](../README.md)"), size: 30, oid: "0".repeat(40) } as never,
    }).text;
    expect(out).toContain('src="/ann/app/media/main/docs/img/a.png"');
    expect(out).toContain('href="/ann/app/blob/main/README.md"');
  });
});
