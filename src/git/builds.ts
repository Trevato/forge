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
import { keptPins, pinsMoved } from "./pins_kept.ts";

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
  /** The demo this pin is, when it names one. */
  readonly demo?: Demo | undefined;
  /** Its notes, ranked, when it has any (`withNotes`); `note` is then the first one's text. */
  readonly notes?: readonly BuildNote[] | undefined;
  /** The tag message's note, when `note` holds the first of its notes instead. */
  readonly tagNote?: string | undefined;
}

/**
 * How a demo opens: `file` plays or downloads its captured HTML page, `env`
 * opens a running build preview of its commit, `shots` shows screenshots.
 */
export const LAUNCHES = ["file", "env", "shots"] as const;
export type Launch = (typeof LAUNCHES)[number];

export const isLaunch = (value: unknown): value is Launch =>
  typeof value === "string" && (LAUNCHES as readonly string[]).includes(value);

/** A pin's demo: what a display shows and opens. */
export interface Demo {
  /** The demo it belongs to: pins sharing a name are one demo's builds. */
  readonly name: string;
  readonly version: string;
  /** How it opens; unset follows the repository's `app.launch` (`launchOf`). */
  readonly launch?: Launch | undefined;
  /** The page it opens, `/` or `/spicy`. */
  readonly page: string;
  /** On display pages: chosen by a person, never by default. */
  readonly showcase: boolean;
  /** An uploaded cover: a blob kept by `refs/covers/<label>`. */
  readonly cover?: string | undefined;
}

/**
 * How a demo opens: its pin's `Launch:`, else the repository's
 * `app.launch`, else `file` when the app names pages to play and `env`
 * when it names none.
 */
export function launchOf(
  demo: Pick<Demo, "launch"> | undefined,
  appLaunch: Launch | undefined,
  pages: readonly string[],
): Launch {
  return demo?.launch ?? appLaunch ?? (pages.length > 0 ? "file" : "env");
}

export const COVERS_PREFIX = "refs/covers/";

/** A demo fact: one plain line, at most `max` characters. */
const isFact = (s: string, max: number): boolean =>
  s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f<>]/.test(s) && s.trim() === s;

/** A page a demo may name: a path of plain segments. */
export const isDemoPage = (page: string): boolean =>
  page.length <= 200 && /^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/.test(page) && !page.includes("..");

/** Whether a demo's facts are all well formed. */
export function isDemo(demo: Demo): boolean {
  return (
    isFact(demo.name, 60) &&
    isFact(demo.version, 40) &&
    (demo.launch === undefined || isLaunch(demo.launch)) &&
    isDemoPage(demo.page) &&
    (demo.cover === undefined || isSafeOid(demo.cover))
  );
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
  | "invalid_demo"
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
  readonly demo?: Demo | undefined;
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

  if (input.demo !== undefined && !isDemo(input.demo)) return err("invalid_demo");

  const at = input.at ?? Math.floor(Date.now() / 1000);
  const note = input.note.replace(/\r/g, "").trim();
  const message = pinMessage(note === "" ? input.label : note, input.parent, oneLine(input.source) || "commit", input.demo);
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
  pinsMoved(dir);
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
    demo: input.demo,
  });
}

/** A pin's message: its note, then its trailers. Always the new trailers. */
function pinMessage(note: string, parent: string | undefined, source: string, demo: Demo | undefined): string {
  const trailers = [
    ...(parent === undefined ? [] : [`Parent: ${parent}`]),
    `Source: ${source}`,
    ...(demo === undefined
      ? []
      : [
          `Demo: ${demo.name}`,
          `Version: ${demo.version}`,
          ...(demo.launch === undefined ? [] : [`Launch: ${demo.launch}`]),
          `Page: ${demo.page}`,
          ...(demo.showcase ? ["Showcase: on"] : []),
          ...(demo.cover === undefined ? [] : [`Cover: ${demo.cover}`]),
        ]),
  ];
  return `${note}\n\n${trailers.join("\n")}\n`;
}

/** Every trailer a pin may carry. */
const TRAILER = /^(Parent|Source|Demo|Cart|Version|Launch|Producer|Page|Showcase|Shelf|Cover): (.*)$/;

/** What a pin's message carries, as `parsePinMessage` reads it. */
export interface PinMessage {
  readonly note: string;
  readonly parent: string | undefined;
  readonly source: string;
  readonly demo: Demo | undefined;
  /** Whether it carries any old trailer: `Cart:`, `Shelf:` or `Producer:`. */
  readonly legacy: boolean;
  /** The old `Producer:`, when it carries one. */
  readonly producer: string | undefined;
}

/** The trailers block at the end of a pin's message, and the note above it. */
export function parsePinMessage(text: string): PinMessage {
  const lines = text.replace(/\n+$/, "").split("\n");
  let parent: string | undefined;
  let source = "commit";
  const facts = new Map<string, string>();
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]!;
    const m = TRAILER.exec(line);
    if (m === null) break;
    if (m[1] === "Parent" && isPinParent(m[2]!)) parent = m[2]!;
    else if (m[1] === "Source") source = m[2]!;
    else if (!facts.has(m[1]!)) facts.set(m[1]!, m[2]!);
    end--;
  }
  // A new trailer wins over its old name when a tag carries both. An old
  // `Cart:` was always a captured page: with no `Launch:`, it is `file`.
  const name = facts.get("Demo") ?? facts.get("Cart");
  const cover = facts.get("Cover");
  const launch = facts.get("Launch") ?? (facts.has("Demo") || !facts.has("Cart") ? undefined : "file");
  const demo: Demo | undefined =
    name === undefined
      ? undefined
      : {
          name,
          version: facts.get("Version") ?? "",
          ...(launch === undefined ? {} : { launch: launch as Launch }),
          page: facts.get("Page") ?? "/",
          showcase: (facts.get("Showcase") ?? facts.get("Shelf")) === "on",
          ...(cover === undefined ? {} : { cover }),
        };
  return {
    note: lines.slice(0, end).join("\n").trim(),
    parent,
    source,
    demo: demo !== undefined && isDemo(demo) ? demo : undefined,
    legacy: facts.has("Cart") || facts.has("Shelf") || facts.has("Producer"),
    producer: facts.get("Producer"),
  };
}

export type SetDemoError = "invalid_demo" | "not_found" | "moved" | "git_failed";

/** A pin's tag as `rewritePin` reads it: the tag object, its commit, its tagger line and its message. */
interface PinTag {
  readonly tag: string;
  readonly object: string;
  readonly tagger: { readonly name: string; readonly email: string; readonly at: string; readonly zone: string };
  readonly message: PinMessage;
}

/**
 * Write a new tag object for the pin `label`'s commit, keeping its tagger,
 * date and message, with the demo `change` makes of what it holds. The ref
 * moves only from the tag read here, so two edits never cross. Notes are
 * never written here: they live on `refs/forge/notes`.
 */
async function rewritePin(
  dir: string,
  label: string,
  change: (old: PinTag) => Demo | undefined,
): Promise<Result<BuildPin, "not_found" | "moved" | "git_failed">> {
  if (!isPinLabel(label)) return err("not_found");
  const ref = `${BUILDS_PREFIX}${label}`;
  const old = await runGitCapture(["rev-parse", "--verify", "--quiet", ref], { cwd: dir });
  const oldTag = old.stdout.trim();
  if (old.code !== 0 || !isSafeOid(oldTag)) return err("not_found");
  const body = await runGit(["cat-file", "tag", oldTag], { cwd: dir });
  if (!body.ok) return err("not_found");
  const split = body.value.indexOf("\n\n");
  const head = split === -1 ? body.value : body.value.slice(0, split);
  const tagger = /^tagger (.*) <([^>]*)> (\d+) ([+-]\d{4})$/m.exec(head);
  const object = /^object ([0-9a-f]+)$/m.exec(head)?.[1];
  if (tagger === null || object === undefined) return err("not_found");
  const message = parsePinMessage(split === -1 ? "" : body.value.slice(split + 2));
  const demo = change({ tag: oldTag, object, tagger: { name: tagger[1]!, email: tagger[2]!, at: tagger[3]!, zone: tagger[4]! }, message });
  const tag =
    `object ${object}\ntype commit\ntag ${label}\n` +
    `tagger ${tagger[1]} <${tagger[2]}> ${tagger[3]} ${tagger[4]}\n\n` +
    pinMessage(message.note === "" ? label : message.note, message.parent, message.source, demo);
  const made = await runGit(["mktag"], { cwd: dir, stdin: tag });
  if (!made.ok) return err("git_failed");
  const moved = await runGitCapture(["update-ref", ref, made.value.trim(), oldTag], { cwd: dir });
  pinsMoved(dir);
  if (moved.code !== 0) return err("moved");
  return ok({
    label,
    oid: object,
    note: message.note,
    parent: message.parent,
    source: message.source,
    pinnedBy: tagger[1]!,
    pinnedAt: new Date(Number(tagger[3]) * 1000).toISOString(),
    demo,
  });
}

/**
 * Give the pin `label` these demo facts, or none: a new tag object for the
 * same commit, with the same tagger, date, note, parent and source, and
 * only the new trailers.
 */
export async function setPinDemo(
  dir: string,
  label: string,
  demo: Demo | undefined,
): Promise<Result<BuildPin, SetDemoError>> {
  if (demo !== undefined && !isDemo(demo)) {
    if (!isPinLabel(label)) return err("not_found");
    return err("invalid_demo");
  }
  const done = await rewritePin(dir, label, () => demo);
  if (!done.ok) return done;
  return ok(withNotes(done.value, (await readBuildNotes(dir, [label])).get(label)));
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
    pinsMoved(dir);
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

/** Whether `bytes` start like a PNG, JPEG or WebP picture. */
export function coverType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

export type DeletePinError = "not_found" | "moved" | "git_failed";

/**
 * Delete the pin `label`: `refs/builds/<label>`, with its cover and its
 * screenshots, in one ref transaction. The pin's ref goes only from the tag
 * read here, so a pin changed meanwhile is not deleted. The commit stays.
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
  // The pin's cover and curated screenshots (`git/shots.ts`) go with it, so a label pinned again starts bare.
  for (const other of [`${COVERS_PREFIX}${label}`, `refs/shots/${label}`]) {
    const at = await read(other);
    if (at !== undefined) lines.push(`delete ${other} ${at}`);
  }
  const done = await runGitCapture(["update-ref", "--stdin"], { cwd: dir, stdin: `start\n${lines.join("\n")}\nprepare\ncommit\n` });
  pinsMoved(dir);
  if (done.code !== 0) return err(/cannot lock|is at|expected/i.test(done.stderr) ? "moved" : "git_failed");
  return ok({ oid: commit.stdout.trim(), tag });
}

/** One pin by label with its tag message's note, its notes file not read. */
async function readTagPin(dir: string, label: string): Promise<BuildPin | undefined> {
  if (!isPinLabel(label)) return undefined;
  return (await listTagPins(dir, label))[0];
}

/** The largest cover a person may upload. */
export const COVER_MAX = 2 * 1024 * 1024;

/** Store a cover picture as a blob kept by `refs/covers/<label>`; its id. */
export async function storeCover(dir: string, label: string, bytes: Uint8Array): Promise<Result<string, "invalid_cover" | "git_failed">> {
  if (!isPinLabel(label) || bytes.length > COVER_MAX || coverType(bytes) === undefined) return err("invalid_cover");
  const blob = await runGit(["hash-object", "-w", "--stdin"], { cwd: dir, stdin: bytes });
  if (!blob.ok) return err("git_failed");
  const oid = blob.value.trim();
  const kept = await runGitCapture(["update-ref", `${COVERS_PREFIX}${label}`, oid], { cwd: dir });
  return kept.code === 0 ? ok(oid) : err("git_failed");
}

/** A stored cover's bytes, read only through a pin that names it. */
export async function readCover(dir: string, oid: string): Promise<Uint8Array | undefined> {
  if (!isSafeOid(oid)) return undefined;
  const kind = await runGitCapture(["cat-file", "-t", oid], { cwd: dir });
  if (kind.code !== 0 || kind.stdout.trim() !== "blob") return undefined;
  const bytes = await runGitRaw(["cat-file", "blob", oid], { cwd: dir });
  return bytes.ok ? bytes.value : undefined;
}

/**
 * Every pin, newest first, read in one `for-each-ref`; or the one `label`.
 * A pin's note is its notes file on `refs/forge/notes` when it has one,
 * else its tag message's.
 */
export async function listBuildPins(dir: string, label?: string): Promise<BuildPin[]> {
  // The whole listing is kept per repository (`pins_kept.ts`); one label is read fresh.
  if (label === undefined) return [...(await keptPins(dir, () => readBuildPins(dir)))];
  return readBuildPins(dir, label);
}

async function readBuildPins(dir: string, label?: string): Promise<BuildPin[]> {
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
      demo: message.demo,
    });
  }
  return pins;
}

/** A pin's note as its notes, whole: a first line that only repeats the label is dropped. */
export function wholeNotes(label: string, note: string): string {
  const at = note.indexOf("\n");
  const first = (at === -1 ? note : note.slice(0, at)).trim();
  return first === label ? (at === -1 ? "" : note.slice(at + 1).trim()) : note.trim();
}

/** A pin's note split at its first line: the pin note, then the dev notes. */
export function splitPinNote(label: string, note: string): { readonly note: string; readonly body: string } {
  const at = note.indexOf("\n");
  const first = (at === -1 ? note : note.slice(0, at)).trim();
  return { note: first === label ? "" : first, body: at === -1 ? "" : note.slice(at + 1).trim() };
}

/** One pin by label, or undefined. */
export async function readBuildPin(dir: string, label: string): Promise<BuildPin | undefined> {
  if (!isPinLabel(label)) return undefined;
  return (await listBuildPins(dir, label))[0];
}

/**
 * Whether `pin` is the copy of a parent's pin a fork carries
 * (`copyForgeRefs`): the same label, commit, pinner and time. A family or
 * a display drawing both shows the parent's alone.
 */
export function isCopiedPin(pin: BuildPin, parentPins: readonly BuildPin[]): boolean {
  return parentPins.some((p) => p.label === pin.label && p.oid === pin.oid && p.pinnedAt === pin.pinnedAt && p.pinnedBy === pin.pinnedBy);
}

/** The labels of the pins whose commit `oid` contains, itself included. */
export async function pinsMergedInto(dir: string, oid: string): Promise<Set<string>> {
  if (!isSafeOid(oid)) return new Set();
  const listed = await runGit(
    ["for-each-ref", `--merged=${oid}`, "--format=%(refname:strip=2)", BUILDS_PREFIX.slice(0, -1)],
    { cwd: dir },
  );
  if (!listed.ok) return new Set();
  return new Set(listed.value.split("\n").filter((l) => l !== ""));
}

/** The branches and tags whose history holds `oid`: what a fork, which copies those, carries of it. */
export async function refsContaining(dir: string, oid: string): Promise<{ readonly branches: readonly string[]; readonly tags: readonly string[] }> {
  if (!isSafeOid(oid)) return { branches: [], tags: [] };
  const listed = await runGit(["for-each-ref", `--contains=${oid}`, "--format=%(refname)", "refs/heads", "refs/tags"], { cwd: dir });
  if (!listed.ok) return { branches: [], tags: [] };
  const refs = listed.value.split("\n").filter((l) => l !== "");
  return {
    branches: refs.filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length)),
    tags: refs.filter((r) => r.startsWith("refs/tags/")).map((r) => r.slice("refs/tags/".length)),
  };
}

/** Whether `ancestor` is in `oid`'s history, read in `dir`. */
export async function isAncestor(dir: string, ancestor: string, oid: string): Promise<boolean> {
  if (!isSafeOid(ancestor) || !isSafeOid(oid)) return false;
  const r = await runGitCapture(["merge-base", "--is-ancestor", ancestor, oid], { cwd: dir });
  return r.code === 0;
}
