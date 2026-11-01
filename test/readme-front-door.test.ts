import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// README.md is the front door (#6226): what the forge is, how to run it, and
// an index into docs/. Feature prose goes in the doc that owns the topic.
const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const INDEX = "## Where the rest is";

test("README.md stays under 80 KB", () => {
  const size = statSync(join(root, "README.md")).size;
  if (size >= 80 * 1024)
    throw new Error(
      `README.md is ${size} bytes, over 80 KB. Put feature prose in the docs/ file that owns the topic (README's "${INDEX}" lists them), not in README.md.`,
    );
});

test("every docs/ link in README.md resolves", () => {
  const links = [...readme.matchAll(/\]\((docs\/[^)#\s]*)/g)].map((m) => m[1]!);
  expect(links.length).toBeGreaterThan(0);
  const broken = links.filter((l) => !existsSync(join(root, l)));
  expect(broken).toEqual([]);
});

test(`every top-level docs/*.md is linked from "${INDEX}"`, () => {
  const at = readme.indexOf(`\n${INDEX}\n`);
  expect(at).toBeGreaterThan(-1);
  const index = readme.slice(at).split(/\n## /)[1]!;
  const docs = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md"));
  const unlisted = docs.filter((f) => !index.includes(`](docs/${f})`));
  expect(unlisted).toEqual([]);
});
