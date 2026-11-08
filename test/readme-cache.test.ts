/** A README is rendered once per blob oid: the second look does no markdown work. */
import { beforeEach, expect, test } from "bun:test";
import type { RepoSource, TreeEntry } from "../src/view/source.ts";
import { markdownWorkDone, renderMarkdown } from "../src/web/markdown.ts";
import { clearReadmeCache, readmeFor } from "../src/web/pages/repo.ts";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const encode = (s: string) => new TextEncoder().encode(s);
// Over the markdown memo's own limit, so only the oid cache can save the work.
const BIG = `# Title <script>alert(1)</script>\n\n${"para with *em* and `code`\n\n".repeat(1200)}`;

let reads = 0;
function sourceOf(text: string, where?: unknown): RepoSource {
  return {
    where: where ?? { kind: "local", repo: { id: "r1" } },
    blob: async () => {
      reads++;
      return {
        ok: true,
        value: { kind: "text", body: encode(text), size: text.length },
      };
    },
  } as unknown as RepoSource;
}
const entry = (oid: string): TreeEntry => ({
  mode: "100644",
  type: "blob",
  oid,
  size: 1,
  name: "README.md",
});

beforeEach(() => {
  clearReadmeCache();
  reads = 0;
});

test("the second render of one blob does no markdown work", async () => {
  expect(BIG.length).toBeGreaterThan(20_000);
  const src = sourceOf(BIG);
  const first = await readmeFor(src, "main", [entry(OID_A)], "");
  const before = markdownWorkDone();
  const second = await readmeFor(src, "main", [entry(OID_A)], "");
  expect(markdownWorkDone()).toBe(before);
  expect(reads).toBe(1);
  expect(String(second)).toBe(String(first));
});

test("the README is a bare card, not a box", async () => {
  const out = String(await readmeFor(sourceOf("# hi"), "main", [entry(OID_A)], ""));
  expect(out).toContain('class="card bare"');
});

test("a changed README renders anew", async () => {
  await readmeFor(sourceOf(BIG), "main", [entry(OID_A)], "");
  const before = markdownWorkDone();
  const changed = await readmeFor(
    sourceOf(`${BIG}\nmore`),
    "main",
    [entry(OID_B)],
    "",
  );
  expect(markdownWorkDone()).toBe(before + 1);
  expect(String(changed)).toContain("more");
});

test("cached output is byte-identical to the uncached render and stays escaped", async () => {
  const first = String(
    await readmeFor(sourceOf(BIG), "main", [entry(OID_A)], ""),
  );
  const cached = String(
    await readmeFor(sourceOf(BIG), "main", [entry(OID_A)], ""),
  );
  clearReadmeCache();
  const fresh = String(
    await readmeFor(sourceOf(BIG), "main", [entry(OID_A)], ""),
  );
  expect(cached).toBe(fresh);
  expect(first).toBe(fresh);
  expect(fresh).not.toContain("<script>");
  expect(fresh).toContain("&lt;script&gt;");
  expect(fresh).toContain(String(renderMarkdown(BIG)).slice(0, 200));
});

const origin = (id: string, fullName: string) => ({
  kind: "origin",
  origin: { id },
  fullName,
});

test("two repositories reporting one oid each get their own card", async () => {
  const real = await readmeFor(sourceOf("# Real"), "main", [entry(OID_A)], "");
  const hostile = await readmeFor(
    sourceOf("# Hostile", origin("o1", "evil/x")),
    "main",
    [entry(OID_A)],
    "",
  );
  expect(String(hostile)).toContain("Hostile");
  expect(String(hostile)).not.toContain("Real");
  const again = await readmeFor(sourceOf("# Real"), "main", [entry(OID_A)], "");
  expect(String(again)).toBe(String(real));
});

test("an oid that is not a real object id is never cached", async () => {
  for (const oid of ["", "main", "A".repeat(40)]) {
    clearReadmeCache();
    reads = 0;
    await readmeFor(sourceOf("# One"), "main", [entry(oid)], "");
    const two = await readmeFor(sourceOf("# Two"), "main", [entry(oid)], "");
    expect(String(two)).toContain("Two");
    expect(reads).toBe(2);
  }
});
