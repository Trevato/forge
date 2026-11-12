/**
 * `bun scripts/take-template.ts <checkout> [owner/name]`: write
 * `templates/app-template.json`, the copy of the app template every forge
 * carries in its image (#10305), from a checkout of the template repository.
 * The tracked files at HEAD are taken as they are and HEAD is recorded as
 * `commit` in the bundle. It is meant to run on a checkout of
 * trevato/app-template at the commit a release pins (the release build does
 * not do so yet); a checkout without a readable `template.json`, or with a
 * file that is not UTF-8 text, is refused. `pinned: true` marks a bundle
 * taken this way; the file in the tree says `pinned: false` until one is.
 */

import { parseTemplateSpec } from "../src/apps/template.ts";

const [dir, repo = "trevato/app-template"] = process.argv.slice(2);
// FORGE_TEMPLATE_OUT: where to write (tests); default the tree's bundle.
const out = process.env["FORGE_TEMPLATE_OUT"] ?? `${import.meta.dir}/../templates/app-template.json`;
if (dir === undefined) {
  console.error("usage: bun scripts/take-template.ts <checkout> [owner/name]");
  process.exit(2);
}
const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    console.error(`take-template: git ${args[0]} failed: ${r.stderr.toString().trim()}`);
    process.exit(1);
  }
  return r.stdout.toString();
};
const commit = git("rev-parse", "HEAD").trim();
const paths = git("ls-files", "-z").split("\0").filter((p) => p !== "").sort();
// The bundle is JSON text, so a file that is not UTF-8 text is refused, not
// mangled: read the bytes and decode them strictly.
const files: Record<string, string> = {};
const decoder = new TextDecoder("utf-8", { fatal: true });
for (const p of paths) {
  const bytes = new Uint8Array(await Bun.file(`${dir}/${p}`).arrayBuffer());
  try {
    const body = decoder.decode(bytes);
    if (body.includes("\u0000")) throw new Error("NUL byte");
    files[p] = body;
  } catch {
    console.error(`take-template: ${p} is not UTF-8 text; the bundle holds text files only`);
    process.exit(1);
  }
}
if (files["template.json"] === undefined || parseTemplateSpec(files["template.json"]) === undefined) {
  console.error("take-template: the checkout has no readable template.json");
  process.exit(1);
}
await Bun.write(
  out,
  `${JSON.stringify({ repo, commit, pinned: true, files }, null, 1)}\n`,
);
console.log(`took ${paths.length} files of ${repo} at ${commit}`);
