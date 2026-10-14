/**
 * The parsers that take outside input, fed a generator's cases. Seeded
 * (`FUZZ_SEED`, `FUZZ_RUNS`): a failure prints the seed and the shrunk case.
 * A case that once failed is kept in test/fuzz-found.test.ts as a fixed test.
 */
import { describe, expect, test } from "bun:test";
import { parseCheck, parseManifest } from "../src/apps/manifest.ts";
import { isSlug } from "../src/core/apps.ts";
import { isHostname, normalizeHost } from "../src/core/domains.ts";
import { readContract } from "../src/contract/can.ts";
import { parseUnifiedDiff } from "../src/git/diff.ts";
import { body } from "../src/http/respond.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { fuzz, int, mix, pick, type Rand } from "./helpers/fuzz.ts";

const JSONISH = [
  "{", "}", "[", "]", ",", ":", '"app"', '"run"', '"check"', '"fast"', '"ready"',
  '"health"', '"limits"', '"looks"', '"tty"', '"service"', '"test"', '"install"',
  '"memory"', '"cpus"', '"disk"', '"timeout"', "null", "true", "0", "-1", "1e999",
  "600", "601", '"bun run x"', '"/healthz"', '"\\u0000"', '"a b"', "{}", "[]",
  '"__proto__"', '"constructor"',
];

/** A forge.json-shaped value built from random fields, or broken text. */
const manifestText = (r: Rand): string => {
  if (r() < 0.4) return mix(r, JSONISH, 30);
  const value = (depth: number): unknown => {
    const roll = r();
    if (roll < 0.2) return int(r, 3000) - 5;
    if (roll < 0.4) return pick(r, ["", "bun run x", "/", "/x y", "a\u0000b", "x".repeat(1001), "\n"]);
    if (roll < 0.5) return pick(r, [null, true, false]);
    if (roll < 0.7 && depth < 3) return [value(depth + 1), value(depth + 1)].slice(0, int(r, 3));
    if (depth < 3) return obj(depth + 1);
    return null;
  };
  const obj = (depth: number): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let n = int(r, 6); n > 0; n--)
      o[pick(r, ["run", "install", "test", "health", "ready", "tty", "looks", "service", "limits", "memory", "cpus", "disk", "fast", "timeout", "egress", "__proto__"])] = value(depth);
    return o;
  };
  return JSON.stringify({ app: obj(0), check: obj(0), egress: value(0) });
};

describe("fuzz: manifests", () => {
  test("parseManifest and parseCheck never throw and keep their bounds", async () => {
    await fuzz("manifest", manifestText, (text) => {
      for (const pkg of [undefined, '{"scripts":{"start":"bun x"}}']) {
        const m = parseManifest(text, pkg);
        if (m.ok) {
          expect(m.value.run.length).toBeGreaterThan(0);
          expect(m.value.run.length).toBeLessThanOrEqual(1000);
          expect(m.value.ready).toBeGreaterThan(0);
          expect(m.value.ready).toBeLessThanOrEqual(600);
          expect(m.value.looks.length).toBeLessThanOrEqual(3);
        } else expect(["not_an_app", "invalid"]).toContain(m.error.kind);
        const c = parseCheck(text, pkg);
        if (!c.ok) expect(c.error.kind).toBe("invalid");
      }
    });
  });

  test("raw garbage as package.json is refused, never thrown", async () => {
    await fuzz("package.json", (r) => mix(r, JSONISH, 30), (text) => {
      const m = parseManifest(undefined, text);
      if (!m.ok) expect(["not_an_app", "invalid"]).toContain(m.error.kind);
    });
  });
});

describe("fuzz: contract.json", () => {
  const CONTRACT = [
    ...JSONISH, '"roles"', '"resources"', '"holds"', '"verbs"', '"create"',
    '"read"', '"nobody"', '"by"', '"row"', '"column"', '"owner"', '"admin"',
  ];
  test("readContract answers ok or problems, never throws", async () => {
    await fuzz("contract", (r) => mix(r, CONTRACT, 40), (text) => {
      const read = readContract(text);
      if (!read.ok) expect(read.problems.length).toBeGreaterThan(0);
    });
  });
});

describe("fuzz: hostnames and slugs", () => {
  const HOST = ["a", "b", "-", ".", "..", "xn--", "0", "9", "example", "com", "A", " ", "_", "é", "\u0000", "/", ":", "x".repeat(64), "1.2.3.4"];
  test("a hostname that passes is DNS-shaped and normalizing is stable", async () => {
    await fuzz("hostname", (r) => mix(r, HOST), (text) => {
      const host = normalizeHost(text);
      if (isHostname(host)) {
        // What is stored is looked up by normalizing again: it must not move.
        expect(normalizeHost(host)).toBe(host);
        expect(host.length).toBeLessThanOrEqual(253);
        for (const label of host.split(".")) {
          expect(label).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
        }
        expect(host.split(".").length).toBeGreaterThanOrEqual(2);
        expect(host.split(".").at(-1)!).not.toMatch(/^\d+$/);
      }
    });
  });

  test("a slug that passes has no `--`, no edge hyphen, and fits", async () => {
    await fuzz("slug", (r) => mix(r, ["a", "z", "0", "-", "--", "_", ".", " ", "A", "/", "x".repeat(20)]), (text) => {
      if (isSlug(text)) {
        expect(text).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(text.length).toBeLessThanOrEqual(40);
        expect(text).not.toContain("--");
      }
    });
  });
});

describe("fuzz: markdown", () => {
  const MD = [
    "# ", "## ", "- ", "1. ", "> ", "```", "~~~", "`", "*", "**", "_", "[", "](", ")",
    "![", "<", ">", "&", '"', "'", "\n", "\n\n", "\r\n", " ", "    ", "|", "---", "javascript:",
    "data:text/html,", "<script>", "</script>", "<img src=x onerror=alert(1)>", "<a href=",
    "http://x.test", "onclick=", "&#x3C;", "‮", "\u0000", "x",
  ];
  test("never throws, and no input becomes a live tag or script URL", async () => {
    await fuzz("markdown", (r) => mix(r, MD, 40), (text) => {
      const out = renderMarkdown(text).toString();
      // Only tags the renderer owns may appear; anything the author typed is escaped.
      const tags = [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase());
      for (const tag of tags)
        expect(["p","h1","h2","h3","h4","h5","h6","ul","ol","li","blockquote","pre","code","em","strong","a","br","hr","table","thead","tbody","tr","th","td","del","img","span","div","input"]).toContain(tag);
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/<[^>]*\son\w+\s*=/i);
      expect(out).not.toMatch(/(?:href|src)=["']\s*(?:javascript|data|vbscript):/i);
    });
  });
});

describe("fuzz: the diff reader", () => {
  const DIFF = [
    "diff --git a/x b/x\n", "--- a/x\n", "+++ b/x\n", "@@ -1,2 +1,2 @@\n", "@@ -0,0 +1 @@\n",
    "@@ -1 +1 @@ ctx\n", "@@ -99999999999,1 +1,0 @@\n", "@@ garbage @@\n", "+add\n", "-del\n",
    " ctx\n", "\\ No newline at end of file\n", "Binary files a/x and b/x differ\n",
    "new file mode 100644\n", "deleted file mode 100644\n", "rename from a\n", "rename to b\n",
    "similarity index 90%\n", "index 1..2 100644\n", "\n", "\r\n", "+++ b/\"q\\\"\"\n", "\u0000",
  ];
  test("parseUnifiedDiff never throws and its hunks are sane", async () => {
    await fuzz("diff", (r) => mix(r, DIFF, 30), (text) => {
      const diff = parseUnifiedDiff(text);
      for (const file of diff.files)
        for (const hunk of file.hunks)
          for (const line of hunk.lines)
            expect(["context", "add", "del"]).toContain(line.kind);
    });
  });
});

describe("fuzz: the API's JSON bodies", () => {
  test("body() is always a plain object, whatever the bytes", async () => {
    await fuzz("body", (r) => mix(r, JSONISH, 30), async (text) => {
      const parsed = await body(new Request("http://x.test/", { method: "POST", body: text }));
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    });
  });
});
