import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coldRead } from "../src/design/coldrun.ts";
import { tokenRefusal, filingPlan, writeRefusal, PAGES, REPO, findingIssue, refusal, repoPages, toFile, parseAnswer, scorePage, withColdRead } from "../src/design/coldread.ts";

const ok = (clarity: number, n = 1) => ({ confusing: Array(n).fill("the banner is unclear"), clickFirst: "the big button", clarity });

describe("cold-read audit (#5882)", () => {
  test("reads the model's JSON and refuses what is not", () => {
    expect(parseAnswer('sure: {"confusing":["a"],"clickFirst":"b","clarity":4}')).toEqual({ confusing: ["a"], clickFirst: "b", clarity: 4 });
    expect(typeof parseAnswer("no")).toBe("string");
    expect(typeof parseAnswer('{"confusing":"a","clickFirst":"b","clarity":4}')).toBe("string");
    expect(typeof parseAnswer('{"confusing":[],"clickFirst":"b","clarity":9}')).toBe("string");
  });
  test("scores a page by the mean of its widths", () => {
    const s = scorePage([{ device: "phone", answer: ok(2, 2) }, { device: "desktop", answer: ok(4) }]);
    expect(s).toMatchObject({ clarity: 3, phone: 2, desktop: 4, confusions: 3 });
    expect(scorePage([])).toBeNull();
  });
  test("writes coldRead and keeps the rest of the baseline", () => {
    const out = withColdRead({ files: { a: 1 } }, { at: "x", issue: 5882, mode: "screenshot", pages: {} });
    expect(out["files"]).toEqual({ a: 1 });
    expect(out["coldRead"]).toBeDefined();
  });
  test("a finding links back to its parent", () => {
    expect(findingIssue("/migrate", "phone", "the button", 5882).body).toContain("#5882");
  });
  test("the order starts /migrate, /, new forge; the prompt is in the repository", () => {
    expect(PAGES.slice(0, 3)).toEqual(["/migrate", "/", "/forges/new"]);
    expect(readFileSync("docs/design/cold-read-prompt.md", "utf8")).toContain("under 100 words");
  });

  test("a redirect or a non-200 is refused, a 200 is read", () => {
    expect(refusal("/migrate", 303, "/signin")).toContain("/signin");
    expect(refusal("/a/b", 404)).toContain("404");
    expect(refusal("/", 200)).toBeNull();
  });
  test("repo pages come from the repo, which must be owner/name", () => {
    expect(repoPages("a/b")).toEqual(["/a/b", "/a/b/pulls", "/a/b/issues"]);
    expect(REPO.test("a/b")).toBe(true);
    expect(REPO.test("a/b/../c")).toBe(false);
  });
  test("filing is capped and skips titles already open or repeated", () => {
    const f = [{ title: "A" }, { title: "b" }, { title: "B" }, { title: "c" }];
    expect(toFile(f, new Set(["a"]), 10).map((x) => x.title)).toEqual(["b", "c"]);
    expect(toFile(f, new Set(), 2).map((x) => x.title)).toEqual(["A", "b"]);
  });
  test("design-lint --update keeps coldRead", async () => {
    const dir = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "dl-"));
    Bun.spawnSync(["mkdir", "-p", join(dir, "docs/design/areas"), join(dir, "src/web")]);
    writeFileSync(join(dir, "docs/DESIGN.md"), "");
    writeFileSync(join(dir, "docs/design/baseline.json"), JSON.stringify({ files: {}, coldRead: { at: "x", issue: 1, pages: {} } }));
    const p = Bun.spawnSync(["bun", join(process.cwd(), "scripts/design-lint.ts"), "--update"], { cwd: dir });
    expect(p.stderr.toString()).toBe("");
    expect(JSON.parse(readFileSync(join(dir, "docs/design/baseline.json"), "utf8")).coldRead.issue).toBe(1);
  });
  test("the loop reads, refuses, scores and flags text-only, with a stubbed model", async () => {
    const asked: string[] = [];
    const run = await coldRead(["/", "/migrate"], "w={{width}} d={{device}}", {
      fetchPage: async (p) => (p === "/" ? { status: 200, location: null, html: "<p>hi</p>" } : { status: 303, location: "/signin", html: "" }),
      shoot: async (html) => ({ kind: "text", block: html }),
      ask: async (_s, prompt) => (asked.push(prompt), '{"confusing":["what is this"],"clickFirst":"sign in","clarity":3}'),
      log: () => {},
    });
    expect(asked).toEqual(["w=390 d=phone", "w=1440 d=desktop"]);
    expect(run.pages["/"]).toMatchObject({ clarity: 3, phone: 3, desktop: 3 });
    expect(run.pages["/migrate"]).toBeUndefined();
    expect(run.failed["/migrate"]?.[0]).toContain("/signin");
    expect(run.findings).toHaveLength(2);
    expect(run.mode).toBe("text-only");
  });
  test("a reply that is not an answer fails the page, not the run", async () => {
    const run = await coldRead(["/"], "", { fetchPage: async () => ({ status: 200, location: null, html: "" }), shoot: async () => ({ kind: "image", block: 1 }), ask: async () => "nope", log: () => {} });
    expect(run.pages).toEqual({});
    expect(run.failed["/"]).toHaveLength(2);
    expect(run.mode).toBe("screenshot");
  });
  test("--write is refused for a text-only or partial read, allowed otherwise", () => {
    expect(writeRefusal({ failed: {}, mode: "screenshot" }, false)).toBeNull();
    expect(writeRefusal({ failed: {}, mode: "text-only" }, false)).toContain("text-only");
    expect(writeRefusal({ failed: {}, mode: "text-only" }, true)).toBeNull();
    expect(writeRefusal({ failed: { "/migrate": ["phone: 303"] }, mode: "screenshot" }, true)).toContain("not read");
  });
  test("filing names its target, stays on the forge it read, skips open titles, honours the cap", () => {
    const o = { forge: "https://f.example/", base: "https://f.example", into: "a/b", open: [], findings: [{ page: "/", device: "phone", text: "x" }, { page: "/", device: "desktop", text: "y" }], parent: 1, cap: 10 };
    const p = filingPlan(o);
    expect("url" in p && p.url).toBe("https://f.example/api/v1/repos/a/b/issues");
    expect("filing" in p && p.filing).toHaveLength(2);
    expect(filingPlan({ ...o, forge: undefined })).toHaveProperty("error");
    expect(filingPlan({ ...o, into: undefined })).toHaveProperty("error");
    expect(filingPlan({ ...o, forge: "https://other.example" })).toHaveProperty("error");
    expect(filingPlan({ ...o, forge: "nonsense" })).toHaveProperty("error");
    const open = filingPlan(o) as { filing: { title: string }[] };
    const again = filingPlan({ ...o, open: [open.filing[0]!.title.toUpperCase()] });
    expect("filing" in again && again.filing).toHaveLength(1);
    const capped = filingPlan({ ...o, cap: 1 });
    expect("skipped" in capped && capped.skipped).toBe(1);
  });
  test("the token goes only to the forge FORGE_URL names", () => {
    expect(tokenRefusal("https://f.example", "https://f.example/")).toBeNull();
    expect(tokenRefusal("https://evil.example", "https://f.example")).toContain("not sent");
    expect(tokenRefusal("http://f.example", "https://f.example")).toContain("not sent");
    expect(tokenRefusal("https://f.example", undefined)).toContain("FORGE_URL");
    expect(tokenRefusal("https://f.example", "nonsense")).toContain("not sent");
  });
});
