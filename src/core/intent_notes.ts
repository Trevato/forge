/**
 * A person's build note, copied verbatim and once into a rolling intent doc,
 * the way ui-iterator copies a round's notes (records/ui-iterator/notes.mjs,
 * `syncIntent`): one list line under "## Iterator notes", carrying a hidden
 * fingerprint so it is never copied twice. Agent notes are never copied:
 * intent holds people's words only. The doc must exist; none is created.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { noteFingerprint, type BuildNote } from "../git/builds.ts";
import { err, ok, type Result } from "../kernel/result.ts";

const HEAD = "## Iterator notes";

/** A line of note text made inert in the doc: no comment can open or close, no heading start. */
export const inert = (line: string): string =>
  line.replace(/<!--/g, "<!- -").replace(/-->/g, "-- >").replace(/^(\s*)#/, "$1\\#");

/** The line `note` is copied as: `- <source> <iteration>, <by>, <date>: <first line> <!-- ui-iterator <fp> -->`, the rest indented. */
export function intentLine(source: string, note: BuildNote): string {
  const [first = "", ...rest] = note.text.split("\n").map(inert);
  const more = rest.map((l) => `  ${l}`).join("\n");
  return `- ${source} ${note.iteration}, ${note.by}, ${note.at.slice(0, 10)}: ${first} <!-- ui-iterator ${noteFingerprint(note)} -->${more ? `\n${more}` : ""}`;
}

/** `doc` with `line` appended at the end of its "## Iterator notes" section, made when missing. */
export function withIntentLine(doc: string, line: string): string {
  let text = doc;
  let at = text.indexOf(HEAD);
  if (at < 0) {
    text = text.replace(/\n*$/, `\n\n${HEAD}\n`);
    at = text.indexOf(HEAD);
  }
  // The section ends before the next heading, or at the end of the file.
  const next = text.slice(at + HEAD.length).search(/\n#{1,2} /);
  const cut = next < 0 ? text.length : at + HEAD.length + next;
  // Continue an existing list without a gap; start a new one after a blank line.
  const kept = text.slice(0, cut).replace(/\n*$/, "");
  const last = kept.slice(kept.lastIndexOf("\n") + 1);
  const before = kept + (last.startsWith("- ") || last.startsWith("  ") ? "\n" : "\n\n");
  return `${before}${line}\n${next < 0 ? "" : `\n${text.slice(cut).replace(/^\n*/, "")}`}`;
}

/** Copy `note` into the intent doc at `file`; answers whether it was written. */
export function copyNoteToIntent(file: string, source: string, note: BuildNote): Result<boolean, "no_doc" | "write_failed"> {
  if (note.kind !== "human") return ok(false);
  if (!existsSync(file)) return err("no_doc");
  try {
    const doc = readFileSync(file, "utf8");
    if (doc.includes(`<!-- ui-iterator ${noteFingerprint(note)} -->`)) return ok(false);
    const tmp = `${file}.forge-tmp`;
    writeFileSync(tmp, withIntentLine(doc, intentLine(source, note)));
    renameSync(tmp, file);
    return ok(true);
  } catch {
    return err("write_failed");
  }
}
