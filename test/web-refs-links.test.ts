import { expect, test } from "bun:test";
import { pathCrumbs, refMenu } from "../src/web/pages/refs.ts";

const hrefs = (h: string) => [...h.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => !h!.startsWith("#i-"));

test("pathCrumbs links each walked directory under one encoded ref segment; the leaf is text", () => {
  const out = pathCrumbs("/r/a", "repo", "feature/a", "src/x.ts", true).toString();
  expect(hrefs(out)).toEqual(["/r/a/tree/feature%2Fa", "/r/a/tree/feature%2Fa/src"]);
  expect(out).toMatch(/>\s*x\.ts\s*<\/span/);
  expect(out).not.toContain("x.ts</a>");
});

test("pathCrumbs with a directory leaf still treats the last crumb as current text", () => {
  const out = pathCrumbs("/r", "repo", "main", "src/lib", false).toString();
  expect(hrefs(out)).toEqual(["/r/tree/main", "/r/tree/main/src"]);
});

test("pathCrumbs encodes hostile refs and segments in hrefs and escapes them in text", () => {
  const out = pathCrumbs("/r", "<n>", `a"<?#`, `d<"?#/e?#/f`, true).toString();
  expect(hrefs(out)).toEqual([
    "/r/tree/a%22%3C%3F%23",
    "/r/tree/a%22%3C%3F%23/d%3C%22%3F%23",
    "/r/tree/a%22%3C%3F%23/d%3C%22%3F%23/e%3F%23",
  ]);
  expect(out).toContain("&lt;n&gt;");
  expect(out).toContain("d&lt;&quot;?#");
  expect(out).not.toMatch(/<n>|d<"/);
});

test("pathCrumbs with an empty path is just the repository crumb", () => {
  const out = pathCrumbs("/r", "repo", "main", "", false).toString();
  expect(out).toContain("repo");
  expect(out.match(/class="sep"/g)).toBeNull();
  expect(out.match(/<a /g)).toBeNull();
});

test("refMenu encodes each href, escapes names and marks the current ref", () => {
  const refs = { branches: ["main", "feature/a", `x"<?#`], tags: ["v1/2"] };
  const out = refMenu(refs, "feature/a", (r) => `/tree/${encodeURIComponent(r)}`).toString();
  expect(hrefs(out)).toEqual([
    "/tree/main",
    "/tree/feature%2Fa",
    "/tree/x%22%3C%3F%23",
    "/tree/v1%2F2",
  ]);
  expect(out).toContain("x&quot;&lt;?#");
  expect(out).not.toContain(`x"<`);
  expect(out.match(/aria-current/g)?.length).toBeGreaterThanOrEqual(1);
  expect(out).toContain("Branches");
  expect(out).toContain("Tags");
});
