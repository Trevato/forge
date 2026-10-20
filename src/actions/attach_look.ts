/**
 * A look a person attaches to a pull (#1066): a picture taken at a stated
 * width, with one line saying what it shows, kept like the forge's own and
 * shown beside them on the change's page.
 *
 * A person who can write the repository attaches; an agent does not (the
 * crew's looks come from the preview, by their own path), a reader and a
 * stranger are refused as they are everywhere. What is sent is checked as
 * bytes, not believed: a PNG or JPEG that reads, of a size we will hold —
 * and it is shown only to the writers, never to whoever else can read.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "../app.ts";
import { previewEnv } from "../apps/data.ts";
import { getAppByRepo } from "../core/apps.ts";
import {
  attachedPage,
  lookSlot,
  recordLook,
  type Look,
  type LookKind,
} from "../core/looks.ts";
import type { Pull } from "../core/pulls.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { jpegHeader, isJpeg } from "../design/image/jpeg.ts";
import { isPng, pngHeader } from "../design/image/png.ts";
import { id as newId } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { AccessError } from "./access.ts";

/** The most a picture may weigh, as bytes. */
export const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
/** The most a line saying what it shows may hold. */
export const ATTACH_NOTE_MAX = 200;
/** The most a side of a picture may be, in pixels. */
const SIDE_MAX = 8192;

export type AttachError =
  | AccessError
  | "not_open"
  | "no_app"
  | "bad_width"
  | "bad_note"
  | "bad_image"
  | "too_large";

export interface AttachInput {
  /** `phone` or `desktop`. */
  readonly width: string;
  /** One line saying what the picture shows. */
  readonly note: string;
  /** The picture, base64. */
  readonly image: string;
}

/** The picture as bytes and its kind, or why it is not one to keep. */
export function readImage(
  encoded: string,
): Result<{ bytes: Uint8Array; ext: "png" | "jpg"; width: number; height: number }, "bad_image" | "too_large"> {
  // Four characters carry three bytes: refuse by length before decoding.
  if (encoded.length > Math.ceil((ATTACH_MAX_BYTES * 4) / 3) + 4)
    return err("too_large");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    return err("bad_image");
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (bytes.length > ATTACH_MAX_BYTES) return err("too_large");
  let ext: "png" | "jpg";
  let size: { width: number; height: number };
  if (isPng(bytes)) {
    const head = pngHeader(bytes);
    if (!head.ok) return err("bad_image");
    ext = "png";
    size = head.value;
  } else if (isJpeg(bytes)) {
    const head = jpegHeader(bytes);
    if (!head.ok) return err("bad_image");
    ext = "jpg";
    size = head.value;
  } else return err("bad_image");
  if (size.width > SIDE_MAX || size.height > SIDE_MAX) return err("bad_image");
  return ok({ bytes, ext, width: size.width, height: size.height });
}

/** One line of at most `ATTACH_NOTE_MAX` characters, no control characters. */
export function cleanNote(raw: string): Result<string, "bad_note"> {
  const note = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (note === "" || [...note].length > ATTACH_NOTE_MAX || /[\u0000-\u001f\u007f]/.test(note))
    return err("bad_note");
  return ok(note);
}

export function attachLook(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  input: AttachInput,
  dry = false,
): Result<Look, AttachError> {
  if (pull.repoId !== repo.id || !canRead(app.db, repo, actor))
    return err("not_found");
  if (!actor) return err("unauthorized");
  if (actor.kind !== "user" || !canWrite(app.db, repo, actor))
    return err("forbidden");
  if (pull.state !== "open" || pull.mergedAt !== null) return err("not_open");
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("no_app");
  if (input.width !== "phone" && input.width !== "desktop")
    return err("bad_width");
  const kind: LookKind = input.width;
  const note = cleanNote(input.note);
  if (!note.ok) return note;
  const image = readImage(input.image);
  if (!image.ok) return image;

  const env = previewEnv(pull.number);
  const page = attachedPage(newId());
  const path = join(
    "looks",
    record.id,
    env,
    `${pull.headOid}-${lookSlot(page, kind)}.${image.value.ext}`,
  );
  const out = join(app.config.dataDir, path);
  // A dry run has checked everything and writes nothing.
  if (dry)
    return ok({
      id: "",
      appId: record.id,
      env,
      commitOid: pull.headOid,
      page,
      kind,
      theme: "light",
      path,
      createdAt: new Date().toISOString(),
      error: null,
      takenAs: "owner",
      attachedBy: actor.username,
      note: note.value,
    });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, image.value.bytes);
  const look = recordLook(app.db, {
    appId: record.id,
    env,
    commitOid: pull.headOid,
    page,
    kind,
    path,
    attachedBy: actor.username,
    note: note.value,
  });
  app.bus.append({
    kind: "look.attached",
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: pull.number, width: kind },
  });
  return ok(look);
}
