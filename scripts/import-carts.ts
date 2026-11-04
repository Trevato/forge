/**
 * Import carts built outside the forge into a forge's data directory
 * (`src/arcade/import.ts`).
 *
 *   bun scripts/import-carts.ts <data-dir> <carts.json> [tagger-name] [tagger-email]
 *
 * carts.json is a list of entries: `repo`, `label`, `sha`, `note`, `cart`
 * (`name`, `version`, `page`, `shelf`; a `producer` is ignored, the
 * Arcade names its own), and the paths `file`,
 * `cover` and `art`, relative to the JSON file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { importCart } from "../src/arcade/import.ts";

const [dataDir, list, name = "forge", email = "forge@localhost"] = process.argv.slice(2);
if (dataDir === undefined || list === undefined) {
  console.error("usage: bun scripts/import-carts.ts <data-dir> <carts.json> [tagger-name] [tagger-email]");
  process.exit(2);
}
const here = dirname(resolve(list));
const read = (path: unknown): Uint8Array | string => {
  if (typeof path !== "string" || path === "") return "a path is missing";
  const full = resolve(here, path);
  if (!existsSync(full)) return `${path} is not there`;
  return new Uint8Array(readFileSync(full));
};
const isText = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const parsed: unknown = JSON.parse(readFileSync(list, "utf8"));
if (!Array.isArray(parsed)) {
  console.error(`${list}: expected a list of carts`);
  process.exit(2);
}
let failed = false;
const refuse = (what: string, why: string) => {
  failed = true;
  console.error(`${what}: ${why}`);
};
for (const [n, raw] of parsed.entries()) {
  const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const cart = (typeof e.cart === "object" && e.cart !== null ? e.cart : {}) as Record<string, unknown>;
  const what = isText(e.repo) && isText(e.label) ? `${e.repo} ${e.label}` : `entry ${n}`;
  if (!isText(e.repo) || !isText(e.label) || !isText(e.sha, 64)) { refuse(what, "repo, label and sha are text"); continue; }
  if (!isText(cart.name) || !isText(cart.version) || !isText(cart.page) || typeof cart.shelf !== "boolean") { refuse(what, "cart needs name, version, page and shelf"); continue; }
  if (e.note !== undefined && typeof e.note !== "string") { refuse(what, "note is text"); continue; }
  const html = read(e.file);
  if (typeof html === "string") { refuse(what, `file: ${html}`); continue; }
  const cover = e.cover === undefined ? undefined : read(e.cover);
  const art = e.art === undefined ? undefined : read(e.art);
  if (typeof cover === "string" || typeof art === "string") { refuse(what, `cover or art: ${cover ?? art}`); continue; }
  const done = await importCart(
    resolve(dataDir),
    { repo: e.repo, label: e.label, sha: e.sha, cart: { name: cart.name, version: cart.version, page: cart.page, shelf: cart.shelf }, html, cover, art, ...(e.note === undefined ? {} : { note: e.note }) },
    { name, email },
  );
  if (done.ok) console.log(`${what}: ${done.value.pinned ? "pinned, " : ""}${done.value.captured ? "captured" : "capture kept"}`);
  else refuse(what, done.error);
}
process.exit(failed ? 1 : 0);
