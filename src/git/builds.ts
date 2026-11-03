/**
 * Build pins: a person marks a commit as a build worth keeping. A pin is an
 * annotated tag object under `refs/builds/<label>` — the commit, who pinned
 * it and when, a note, and two trailers: `Parent:` (a label, when the
 * person named one) and `Source:` (the pull, branch or commit it came
 * from). Git holds all of it, so nothing here lives only in the database,
 * and pinning runs no check and wakes no agent. Notes live on
 * `refs/forge/notes` (see below).
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";
import { runGit, runGitCapture, runGitRaw } from "./env.ts";
import { isSafeOid, isSafeRef } from "./guard.ts";

export const BUILDS_PREFIX = "refs/builds/";

/** How many pins a lineage reads. A build list is for people to scan. */
export const PIN_LIMIT = 100;

export interface BuildPin {
  readonly label: string;
  /** The pinned commit. */
  readonly oid: string;
  readonly note: string;
  /** The pin the person named as this one's parent: `label` here, or
   * `owner/name:label` for a concept edge to another repository. */
  readonly parent: string | undefined;
  /** Where it was pinned from: `pull #12`, `branch feat/x` or `commit`. */
  readonly source: string;
  readonly pinnedBy: string;
  /** ISO time it was pinned. */
  readonly pinnedAt: string;
  /** Its notes, ranked, when it has any (`withNotes`); `note` is then the first one's text. */
  readonly notes?: readonly BuildNote[] | undefined;
  /** The tag message's note, when `note` holds the first of its notes instead. */
  readonly tagNote?: string | undefined;
}

/** A label is short and plain: letters, digits, `.`, `_` and `-`. */
export function isPinLabel(label: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(label) &&
    !label.endsWith(".lock") &&
    isSafeRef(`${BUILDS_PREFIX}${label}`)
  );
}

/**
 * What a pin may name as its parent: a label here, or `owner/name:label` in
 * another repository — a concept edge, for builds that share an idea but no
 * history.
 */
export function isPinParent(parent: string): boolean {
  const at = parent.lastIndexOf(":");
  if (at === -1) return isPinLabel(parent);
  const repo = parent.slice(0, at);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) && isPinLabel(parent.slice(at + 1));
}

export type PinBuildError =
  | "invalid_label"
  | "invalid_parent"
  | "not_a_commit"
  | "exists"
  | "git_failed";

export interface PinInput {
  readonly label: string;
  readonly oid: string;
  readonly note: string;
  readonly parent?: string | undefined;
  readonly source: string;
  readonly tagger: { readonly name: string; readonly email: string };
  /** Seconds since the epoch; tests pass one to order pins. */
  readonly at?: number;
}

/** One line, no control bytes: what a trailer or tagger field may hold. */
const oneLine = (s: string): string =>
  s.replace(/[\x00-\x1f\x7f<>]/g, " ").trim();

/** Write the tag object and create the ref; an existing label is refused. */
export async function pinBuild(
  dir: string,
  input: PinInput,
): Promise<Result<BuildPin, PinBuildError>> {
  if (!isPinLabel(input.label)) return err("invalid_label");
  if (input.parent !== undefined && !isPinParent(input.parent))
    return err("invalid_parent");
  if (!isSafeOid(input.oid)) return err("not_a_commit");
  const kind = await runGitCapture(["cat-file", "-t", input.oid], { cwd: dir });
  if (kind.code !== 0 || kind.stdout.trim() !== "commit")
    return err("not_a_commit");

  const at = input.at ?? Math.floor(Date.now() / 1000);
  const note = input.note.replace(/\r/g, "").trim();
  const message = pinMessage(note === "" ? input.label : note, input.parent, oneLine(input.source) || "commit");
  const tag =
    `object ${input.oid}\ntype commit\ntag ${input.label}\n` +
    `tagger ${oneLine(input.tagger.name) || "forge"} <${oneLine(input.tagger.email)}> ${at} +0000\n\n` +
    message;
  const made = await runGit(["mktag"], { cwd: dir, stdin: tag });
  if (!made.ok) return err("git_failed");
  const created = await runGitCapture(
    ["update-ref", `${BUILDS_PREFIX}${input.label}`, made.value.trim(), ""],
    { cwd: dir },
  );
  if (created.code !== 0)
    return err(/already exists|reference already/i.test(created.stderr) ? "exists" : "git_failed");
  return ok({
    label: input.label,
    oid: input.oid,
    note,
    parent: input.parent,
    source: oneLine(input.source) || "commit",
    pinnedBy: oneLine(input.tagger.name) || "forge",
    pinnedAt: new Date(at * 1000).toISOString(),
  });
}

/** A pin's message: its note, then its trailers. */
function pinMessage(note: string, parent: string | undefined, source: string): string {
  const trailers = [...(parent === undefined ? [] : [`Parent: ${parent}`]), `Source: ${source}`];
  return `${note}\n\n${trailers.join("\n")}\n`;
}

const TRAILER = /^(Parent|Source): (.*)$/;

/** The trailers block at the end of a pin's message, and the note above it. */
function parsePinMessage(text: string): { note: string; parent: string | undefined; source: string } {
  const lines = text.replace(/\n+$/, "").split("\n");
  let parent: string | undefined;
  let source = "commit";
  let end = lines.length;
  while (end > 0) {
    const m = TRAILER.exec(lines[end - 1]!);
    if (m === null) break;
    if (m[1] === "Parent" && isPinParent(m[2]!)) parent = m[2]!;
    else if (m[1] === "Source") source = m[2]!;
    end--;
  }
  return { note: lines.slice(0, end).join("\n").trim(), parent, source };
}

/** The most bytes of one note's text. */
export const NOTES_MAX = 10 * 1024;

/** One note's text: plain text, not blank, that may break lines and tab. */
export const isNotes = (text: string): boolean =>
  text.trim() !== "" && new TextEncoder().encode(text).length <= NOTES_MAX && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text);

export type SetNoteError = "invalid_note" | "not_found" | "moved" | "git_failed" | "notes_lost";

/**
 * A build's notes live on `refs/forge/notes` in its repository, in the
 * format ui-iterator keeps beside a round: `notes.json`, `{ "notes": [...] }`,
 * one entry per note. `iteration` is the pin's label (or a fork's or a
 * family's name, for a note on the whole line), `by` the author's name,
 * `kind` `human` or `agent`, `at` an ISO time, `text` plain text.
 *
 * Notes are append-only: a correction is a new note. `notes.lock` holds
 * every note's fingerprint, and an append refuses a `notes.json` that lost
 * one. Each append is one commit by its author. People's notes rank first.
 *
 */
export const NOTES_REF = "refs/forge/notes";
const NOTES_FILE = "notes.json";
const NOTES_LOCK = "notes.lock";

export const NOTE_KINDS = ["human", "agent"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** One note, as `notes.json` holds it. */
export interface BuildNote {
  readonly iteration: string;
  readonly by: string;
  readonly kind: NoteKind;
  readonly at: string;
  readonly text: string;
}

/** A note's fingerprint, as ui-iterator's `notes.lock` keeps it: sha1 over its five fields, first 12 hex. */
export const noteFingerprint = (n: BuildNote): string =>
  createHash("sha1").update([n.iteration, n.by, n.kind, n.at, n.text].join("\u0000")).digest("hex").slice(0, 12);

/** People's notes first, then agents'; each oldest first. */
export const rankNotes = (notes: readonly BuildNote[]): BuildNote[] =>
  [...notes].sort((a, b) => (a.kind === b.kind ? Date.parse(a.at) - Date.parse(b.at) : a.kind === "human" ? -1 : 1));

function isBuildNote(n: unknown): n is BuildNote {
  if (typeof n !== "object" || n === null) return false;
  const o = n as Record<string, unknown>;
  return (
    typeof o["iteration"] === "string" &&
    typeof o["by"] === "string" &&
    (o["kind"] === "human" || o["kind"] === "agent") &&
    typeof o["at"] === "string" &&
    !Number.isNaN(Date.parse(o["at"])) &&
    typeof o["text"] === "string"
  );
}

/** `notes.json` as its notes, in file order; an entry that is not a note is skipped. */
function parseNotesJson(text: string): BuildNote[] {
  try {
    const data: unknown = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data as { notes?: unknown } | null)?.notes;
    return Array.isArray(list)
      ? list.filter(isBuildNote).map((n) => ({ iteration: n.iteration, by: n.by, kind: n.kind, at: n.at, text: n.text }))
      : [];
  } catch {
    return [];
  }
}

/** `notes.lock` as its fingerprints. */
function parseLock(text: string): string[] {
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/** Whether `dir` holds a notes ref, read without spawning git. */
export function holdsNotes(dir: string): boolean {
  try {
    if (statSync(join(dir, NOTES_REF)).isFile()) return true;
  } catch {
    // No loose ref.
  }
  try {
    return readFileSync(join(dir, "packed-refs"), "utf8").includes(` ${NOTES_REF}\n`);
  } catch {
    return false;
  }
}

/** The notes tree's entries at `tip`, raw (`ls-tree -z` lines), by file name. */
async function notesEntries(dir: string, tip: string): Promise<Map<string, { readonly line: string; readonly oid: string }> | undefined> {
  const listed = await runGitCapture(["ls-tree", "-z", tip], { cwd: dir });
  if (listed.code !== 0) return undefined;
  const out = new Map<string, { line: string; oid: string }>();
  for (const line of listed.stdout.split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (m !== null) out.set(m[4]!, { line, oid: m[3]! });
  }
  return out;
}

/** Blobs' text by id, in one `cat-file --batch`. */
async function readBlobs(dir: string, oids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const safe = oids.filter(isSafeOid);
  if (safe.length === 0) return out;
  const read = await runGitRaw(["cat-file", "--batch"], { cwd: dir, stdin: `${safe.join("\n")}\n` });
  if (!read.ok) return out;
  const bytes = read.value;
  const text = new TextDecoder();
  let at = 0;
  while (at < bytes.length) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl === -1) break;
    const [oid, kind, size] = text.decode(bytes.subarray(at, nl)).split(" ");
    if (kind !== "blob" || oid === undefined) {
      at = nl + 1;
      continue;
    }
    const n = Number(size);
    out.set(oid, text.decode(bytes.subarray(nl + 1, nl + 1 + n)));
    at = nl + 1 + n + 1;
  }
  return out;
}

/** The current tip of the notes ref, or undefined when there is none. */
async function notesTip(dir: string): Promise<string | undefined> {
  const at = await runGitCapture(["rev-parse", "--verify", "--quiet", `${NOTES_REF}^{commit}`], { cwd: dir });
  const oid = at.stdout.trim();
  return at.code === 0 && isSafeOid(oid) ? oid : undefined;
}

/** What the notes ref holds at `tip`: its tree, its notes and its lock. */
interface NotesState {
  readonly entries: Map<string, { readonly line: string; readonly oid: string }>;
  readonly notes: readonly BuildNote[];
  readonly lock: readonly string[];
}

async function readNotesState(dir: string, tip: string | undefined): Promise<NotesState | undefined> {
  if (tip === undefined) return { entries: new Map(), notes: [], lock: [] };
  const entries = await notesEntries(dir, tip);
  if (entries === undefined) return undefined;
  const file = entries.get(NOTES_FILE), lock = entries.get(NOTES_LOCK);
  const blobs = await readBlobs(dir, [
    ...(file === undefined ? [] : [file.oid]),
    ...(lock === undefined ? [] : [lock.oid]),
  ]);
  const notes = file === undefined ? [] : parseNotesJson(blobs.get(file.oid) ?? "");
  return { entries, notes, lock: lock === undefined ? [] : parseLock(blobs.get(lock.oid) ?? "") };
}

/** Each listed label's notes, ranked; a label with none is left out. */
export async function readBuildNotes(dir: string, labels: readonly string[]): Promise<Map<string, BuildNote[]>> {
  const out = new Map<string, BuildNote[]>();
  if (labels.length === 0 || !holdsNotes(dir)) return out;
  const tip = await notesTip(dir);
  if (tip === undefined) return out;
  const state = await readNotesState(dir, tip);
  if (state === undefined) return out;
  const wanted = new Set(labels);
  for (const n of state.notes) {
    if (!wanted.has(n.iteration)) continue;
    const list = out.get(n.iteration) ?? [];
    list.push(n);
    out.set(n.iteration, list);
  }
  for (const [label, list] of out) out.set(label, rankNotes(list));
  return out;
}

/** A pin with its notes: `note` becomes the first note's text, and the tag's own note moves to `tagNote`. */
export const withNotes = (pin: BuildPin, notes: readonly BuildNote[] | undefined): BuildPin =>
  notes === undefined || notes.length === 0 ? pin : { ...pin, note: notes[0]!.text, tagNote: pin.note, notes };

/** How many times an append retries when another write moved the notes ref first. */
const NOTES_TRIES = 8;

/**
 * Append `note` to `notes.json` on `refs/forge/notes`, with its fingerprint
 * in `notes.lock`: one commit by `author`, through plumbing, landed with a
 * lease on the tip it read. A `notes.json` missing a locked note is refused.
 */
export async function appendNote(
  dir: string,
  note: BuildNote,
  author: { readonly name: string; readonly email: string },
  message: string,
): Promise<Result<string, "moved" | "git_failed" | "notes_lost">> {
  const env = {
    GIT_AUTHOR_NAME: oneLine(author.name) || "forge",
    GIT_AUTHOR_EMAIL: oneLine(author.email),
    GIT_COMMITTER_NAME: oneLine(author.name) || "forge",
    GIT_COMMITTER_EMAIL: oneLine(author.email),
  };
  for (let attempt = 0; attempt < NOTES_TRIES; attempt++) {
    const tip = await notesTip(dir);
    const state = await readNotesState(dir, tip);
    if (state === undefined) return err("git_failed");
    const have = new Set(state.notes.map(noteFingerprint));
    if (state.lock.some((h) => !have.has(h))) return err("notes_lost");
    const notes = [...state.notes, note];
    const json = await runGit(["hash-object", "-w", "--stdin"], { cwd: dir, stdin: `${JSON.stringify({ notes }, null, 2)}\n` });
    const lock = await runGit(["hash-object", "-w", "--stdin"], {
      cwd: dir,
      stdin: `${JSON.stringify([...new Set(notes.map(noteFingerprint))].sort(), null, 1)}\n`,
    });
    if (!json.ok || !lock.ok) return err("git_failed");
    const drop = new Set([NOTES_FILE, NOTES_LOCK]);
    const lines = [...state.entries].filter(([name]) => !drop.has(name)).map(([, e]) => e.line);
    lines.push(`100644 blob ${json.value.trim()}\t${NOTES_FILE}`, `100644 blob ${lock.value.trim()}\t${NOTES_LOCK}`);
    const tree = await runGit(["mktree", "-z"], { cwd: dir, stdin: lines.map((l) => `${l}\0`).join("") });
    if (!tree.ok) return err("git_failed");
    const commit = await runGit(["commit-tree", tree.value.trim(), ...(tip === undefined ? [] : ["-p", tip]), "-m", message], { cwd: dir, env });
    if (!commit.ok) return err("git_failed");
    const oid = commit.value.trim();
    const moved = await runGitCapture(["update-ref", NOTES_REF, oid, tip ?? ""], { cwd: dir });
    if (moved.code === 0) return ok(oid);
  }
  return err("moved");
}

/**
 * Add a note to the pin `label`: `text` by `who`, now, appended to its
 * notes (`appendNote`). Answers the pin with its notes, the new note and
 * the commit. The tag stays.
 */
export async function notePinBuild(
  dir: string,
  label: string,
  text: string,
  who: { readonly name: string; readonly kind: NoteKind },
  author: { readonly name: string; readonly email: string },
): Promise<Result<{ readonly pin: BuildPin; readonly note: BuildNote; readonly commit: string }, SetNoteError>> {
  if (!isPinLabel(label)) return err("not_found");
  const clean = text.replace(/\r/g, "").trim();
  if (!isNotes(clean)) return err("invalid_note");
  const pin = await readTagPin(dir, label);
  if (pin === undefined) return err("not_found");
  const note: BuildNote = { iteration: label, by: who.name, kind: who.kind, at: new Date().toISOString(), text: clean };
  const written = await appendNote(dir, note, author, `Note on ${label}`);
  if (!written.ok) return written;
  const notes = (await readBuildNotes(dir, [label])).get(label) ?? [note];
  return ok({ pin: withNotes(pin, notes), note, commit: written.value });
}

export type DeletePinError = "not_found" | "moved" | "git_failed";

/**
 * Delete the pin `label`: `refs/builds/<label>`, only from the tag read
 * here, so a pin changed meanwhile is not deleted. The commit stays.
 */
export async function deletePin(dir: string, label: string): Promise<Result<{ readonly oid: string; readonly tag: string }, DeletePinError>> {
  if (!isPinLabel(label)) return err("not_found");
  const read = async (ref: string): Promise<string | undefined> => {
    const at = await runGitCapture(["rev-parse", "--verify", "--quiet", ref], { cwd: dir });
    const oid = at.stdout.trim();
    return at.code === 0 && isSafeOid(oid) ? oid : undefined;
  };
  const ref = `${BUILDS_PREFIX}${label}`;
  const tag = await read(ref);
  if (tag === undefined) return err("not_found");
  const commit = await runGitCapture(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], { cwd: dir });
  const lines = [`delete ${ref} ${tag}`];
  const done = await runGitCapture(["update-ref", "--stdin"], { cwd: dir, stdin: `start\n${lines.join("\n")}\nprepare\ncommit\n` });
  if (done.code !== 0) return err(/cannot lock|is at|expected/i.test(done.stderr) ? "moved" : "git_failed");
  return ok({ oid: commit.stdout.trim(), tag });
}

/** One pin by label with its tag message's note, its notes file not read. */
async function readTagPin(dir: string, label: string): Promise<BuildPin | undefined> {
  if (!isPinLabel(label)) return undefined;
  return (await listTagPins(dir, label))[0];
}

/**
 * Every pin, newest first, read in one `for-each-ref`; or the one `label`.
 * A pin's note is its notes file on `refs/forge/notes` when it has one,
 * else its tag message's.
 */
export async function listBuildPins(dir: string, label?: string): Promise<BuildPin[]> {
  const pins = await listTagPins(dir, label);
  const notes = await readBuildNotes(dir, pins.map((p) => p.label));
  if (notes.size === 0) return pins;
  return pins.map((p) => withNotes(p, notes.get(p.label)));
}

/** `listBuildPins` with each note as its tag message holds it. */
async function listTagPins(dir: string, label?: string): Promise<BuildPin[]> {
  const listed = await runGit(
    [
      "for-each-ref",
      "--sort=-taggerdate",
      `--count=${PIN_LIMIT}`,
      "--format=%(refname:strip=2)%00%(*objectname)%00%(*objecttype)%00%(taggername)%00%(taggerdate:iso-strict)%00%(contents)%00",
      label === undefined ? BUILDS_PREFIX.slice(0, -1) : `${BUILDS_PREFIX}${label}`,
    ],
    { cwd: dir },
  );
  if (!listed.ok || listed.value === "") return [];
  const fields = listed.value.split("\0");
  const pins: BuildPin[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const label = fields[i]!.replace(/^\n/, "");
    if (fields[i + 2] !== "commit" || !isPinLabel(label)) continue;
    const message = parsePinMessage(fields[i + 5]!);
    pins.push({
      label,
      oid: fields[i + 1]!,
      note: message.note,
      parent: message.parent,
      source: message.source,
      pinnedBy: fields[i + 3]!,
      pinnedAt: new Date(fields[i + 4]!).toISOString(),
    });
  }
  return pins;
}
