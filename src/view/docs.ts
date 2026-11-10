/**
 * The forge's own documentation as plain data: the listing of `docs/*.md` in
 * the release's checkout and the text of one file. The page (/docs) and the
 * terminal screen read here, so both show the same list. A name is served
 * only when it is in the listing, so a request's text is looked up, never
 * joined into a path. Docs change only with the release: the listing is kept
 * for the life of the process.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = join(import.meta.dir, "..", "..", "docs");
export const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/;

export interface DocEntry {
  readonly name: string;
  readonly title: string;
}

let listing: readonly DocEntry[] | undefined;

/** The first `#` line of a document, or its file name. */
export function titleOf(name: string, text: string): string {
  const m = /^# +(.+?)\s*#*\s*$/m.exec(text);
  return m?.[1]?.replace(/[`*_]/g, "") ?? name.slice(0, -3);
}

export function docEntries(): readonly DocEntry[] {
  if (listing !== undefined) return listing;
  const out: DocEntry[] = [];
  for (const d of readdirSync(DOCS, { withFileTypes: true })) {
    if (!d.isFile() || !DOC_NAME.test(d.name)) continue;
    out.push({ name: d.name, title: titleOf(d.name, readFileSync(join(DOCS, d.name), "utf8")) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return (listing = out);
}

/** The entry for a name, or undefined when the name is not in the listing. */
export function docEntry(name: string): DocEntry | undefined {
  return DOC_NAME.test(name) ? docEntries().find((e) => e.name === name) : undefined;
}

export function docText(entry: DocEntry): string {
  return readFileSync(join(DOCS, entry.name), "utf8");
}
