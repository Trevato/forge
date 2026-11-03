/**
 * Pin a build: a writer marks one commit as a build worth keeping, under a
 * short label, with a note and where it came from. The pin is a git ref
 * (`git/builds.ts`), so it costs no check run and wakes no agent; the event
 * is what the feed and webhooks read.
 */

import { forget } from "../core/ttl_cache.ts";
import type { App } from "../app.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { copyNoteToIntent } from "../core/intent_notes.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import {
  deletePin as gitDeletePin,
  pinBuild as gitPinBuild,
  noteFingerprint,
  notePinBuild,
  type BuildNote,
  type BuildPin,
  type DeletePinError,
  type PinBuildError,
  type SetNoteError,
} from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { isMirror } from "../origins/write-through.ts";

export interface PinBuildInput {
  readonly label: string;
  readonly oid: string;
  readonly note?: string;
  readonly parent?: string | undefined;
  /** `pull #12`, `branch feat/x` or `commit`. */
  readonly source?: string;
}

export type PinBuildActionError = AccessError | PinBuildError | "mirrored";

/** A person who writes the repository, never an agent, and not on a mirror: who may pin, note or delete. */
function writerOf(app: App, actor: User | undefined, repo: Repo): Result<User, AccessError | "mirrored"> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (writer.value.kind === "agent") return err("forbidden");
  if (isMirror(app, repo)) return err("mirrored");
  return writer;
}

export async function pinBuild(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: PinBuildInput,
): Promise<Result<BuildPin, PinBuildActionError>> {
  // A person who writes, not an agent; a mirror's refs are its origin's.
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const who = commitIdentity(app.config, writer.value);
  const pinned = await gitPinBuild(repoDir(app.reposRoot, repo.ownerName, repo.name), {
    label: input.label.trim(),
    oid: input.oid.trim(),
    note: input.note ?? "",
    parent: input.parent === undefined || input.parent.trim() === "" ? undefined : input.parent.trim(),
    source: input.source ?? "commit",
    tagger: who,
  });
  if (!pinned.ok) return pinned;
  forget(app);
  app.bus.append({
    kind: "build.pinned",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: {
      label: pinned.value.label,
      oid: pinned.value.oid,
      parent: pinned.value.parent ?? null,
      source: pinned.value.source,
    },
  });
  return ok(pinned.value);
}

/**
 * Delete a pin: `refs/builds/<label>` with its cover and screenshots. A
 * person who writes the repository, never an agent. The commit and the
 * pin's notes stay.
 */
export async function deletePin(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
): Promise<Result<{ readonly label: string; readonly oid: string }, AccessError | DeletePinError | "mirrored">> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const gone = await gitDeletePin(dir, label);
  if (!gone.ok) return gone;
  forget(app);
  // Its notes stay: they are append-only (`git/builds.ts`).
  app.bus.append({
    kind: "build.deleted",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { label, oid: gone.value.oid, tag: gone.value.tag },
  });
  return ok({ label, oid: gone.value.oid });
}

/**
 * Add a note to a build: appended to `notes.json` on `refs/forge/notes`,
 * one commit by its author (`git/builds.ts`). `notes` is the note's text;
 * the older `note` and `body` join into it. A person who writes the
 * repository, never an agent (as the API contract says). The note is also copied, once, into the rolling intent doc when
 * the forge names one (`FORGE_NOTES_INTENT`, `core/intent_notes.ts`).
 */
export async function notePin(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  change: { readonly notes?: string | undefined; readonly note?: string | undefined; readonly body?: string | undefined },
): Promise<Result<{ readonly pin: BuildPin; readonly note: BuildNote }, AccessError | SetNoteError | "mirrored">> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const text = change.notes ?? [change.note, change.body].filter((s) => s !== undefined && s.trim() !== "").join("\n\n");
  const who = { name: writer.value.username, kind: "human" as const };
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const noted = await notePinBuild(dir, label, text, who, commitIdentity(app.config, writer.value));
  if (!noted.ok) return noted;
  forget(app);
  const { pin, note, commit } = noted.value;
  app.bus.append({
    kind: "build.noted",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { label, oid: pin.oid, commit, note: noteFingerprint(note), by: note.kind },
  });
  if (note.kind === "human" && app.config.notesIntent !== undefined) {
    const copied = copyNoteToIntent(app.config.notesIntent, `${repo.ownerName}/${repo.name}`, note);
    if (!copied.ok) app.log.warn("note not copied to the intent doc", { file: app.config.notesIntent, error: copied.error });
  }
  return ok({ pin, note });
}
