/**
 * A pin's screenshots (`git/shots.ts`): a writer picks them from the
 * pictures the forge took when a deploy of the pin's commit came up
 * (`looks/service.ts`), or uploads them, then orders them, captions them
 * and removes them: a person who writes the repository, never an agent.
 * Each change may name the tree it was read from (`at`); a list someone
 * else changed since is refused as `moved`.
 *
 * Picking publishes: a phone or desktop picture taken as the owner is the
 * writers' to see, and once it is a screenshot anyone who reads the
 * repository sees it. A writer chooses that, one picture at a time.
 */

import { join } from "node:path";
import type { App } from "../app.ts";
import { getAppByRepo } from "../core/apps.ts";
import { looksForCommits, type Look } from "../core/looks.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { readBuildPin, type BuildPin } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import {
  cleanCaption,
  isCaption,
  readShots,
  SHOTS_LIMIT,
  storeShot,
  writeShots,
  type ShotEntry,
  type Shots,
  type WriteShotsError,
} from "../git/shots.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { AccessError } from "./access.ts";
import { writerOf } from "./builds.ts";

export type ShotsError =
  | AccessError
  | WriteShotsError
  | "mirrored"
  | "invalid_shot"
  | "too_large"
  | "no_such_shot"
  | "nothing_picked";

/** What one change did, as its event says it. */
type Change = "added" | "picked" | "moved" | "captioned" | "removed";

interface Edit {
  readonly writer: User;
  readonly dir: string;
  readonly pin: BuildPin;
  readonly shots: Shots;
}

/** Authorize, find the pin, and read its screenshots; refuse a stale `at`. */
async function begin(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  at?: string,
): Promise<Result<Edit, ShotsError>> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const pin = await readBuildPin(dir, label);
  if (pin === undefined) return err("not_found");
  const shots = await readShots(dir, label);
  // A form names the tree it was drawn from, so a click never lands on a
  // list someone else has since changed.
  if (at !== undefined && at !== "" && at !== (shots.tree ?? "")) return err("moved");
  return ok({ writer: writer.value, dir, pin, shots });
}

/** Write the new list and announce it. */
async function finish(
  app: App,
  repo: Repo,
  edit: Edit,
  entries: readonly ShotEntry[],
  change: Change,
): Promise<Result<Shots, ShotsError>> {
  const written = await writeShots(edit.dir, edit.pin.label, edit.shots.tree, entries);
  if (!written.ok) return written;
  app.bus.append({
    kind: "build.shots",
    repoId: repo.id,
    actorId: edit.writer.id,
    payload: { label: edit.pin.label, oid: edit.pin.oid, change, count: written.value.items.length },
  });
  return written;
}

const kept = (shots: Shots): ShotEntry[] =>
  shots.items.map(({ oid, type, caption, size }) => ({ oid, type, caption, size }));

/** Add an uploaded screenshot at the end. */
export async function uploadShot(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  bytes: Uint8Array,
  caption: string,
  at?: string,
): Promise<Result<Shots, ShotsError>> {
  const edit = await begin(app, actor, repo, label, at);
  if (!edit.ok) return edit;
  const said = cleanCaption(caption);
  if (!isCaption(said)) return err("invalid_caption");
  if (edit.value.shots.items.length >= SHOTS_LIMIT) return err("too_many");
  const stored = await storeShot(edit.value.dir, bytes);
  if (!stored.ok) return stored;
  return finish(app, repo, edit.value, [...kept(edit.value.shots), { ...stored.value, caption: said }], "added");
}

/**
 * The pictures a deploy of the pin's commit came up with, as the forge
 * took them: one per page, width and theme, the newest of each.
 */
export function pickableLooks(app: App, repo: Repo, pin: BuildPin): Look[] {
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return [];
  const seen = new Set<string>();
  return looksForCommits(app.db, [pin.oid]).filter((l) => {
    const key = `${l.page}\0${l.kind}\0${l.theme}`;
    if (l.appId !== record.id || l.commitOid !== pin.oid || l.error !== null || l.kind === "thumb" || l.path === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Copy the looks named by `ids` into the pin's screenshots, in the order named. */
export async function pickShots(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  ids: readonly string[],
  at?: string,
): Promise<Result<Shots, ShotsError>> {
  const edit = await begin(app, actor, repo, label, at);
  if (!edit.ok) return edit;
  const looks = new Map(pickableLooks(app, repo, edit.value.pin).map((l) => [l.id, l]));
  const picked = [...new Set(ids)].map((id) => looks.get(id)).filter((l): l is Look => l !== undefined);
  if (picked.length === 0) return err("nothing_picked");
  if (edit.value.shots.items.length + picked.length > SHOTS_LIMIT) return err("too_many");
  const added: ShotEntry[] = [];
  for (const look of picked) {
    // Read off the event loop: a pick of 12 pictures must not block other requests.
    const bytes = await Bun.file(join(app.config.dataDir, look.path)).bytes().catch(() => undefined);
    if (bytes === undefined) return err("no_such_shot");
    const stored = await storeShot(edit.value.dir, bytes);
    if (!stored.ok) return stored;
    added.push({ ...stored.value, caption: "" });
  }
  return finish(app, repo, edit.value, [...kept(edit.value.shots), ...added], "picked");
}

/** Give one screenshot a new caption, or move it one place up or down. */
export async function editShot(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  file: string,
  change: { readonly caption?: string; readonly move?: "up" | "down"; readonly at?: string },
): Promise<Result<Shots, ShotsError>> {
  const edit = await begin(app, actor, repo, label, change.at);
  if (!edit.ok) return edit;
  const list = kept(edit.value.shots);
  const i = edit.value.shots.items.findIndex((s) => s.file === file);
  if (i === -1) return err("no_such_shot");
  if (change.caption !== undefined) {
    const said = cleanCaption(change.caption);
    if (!isCaption(said)) return err("invalid_caption");
    list[i] = { ...list[i]!, caption: said };
  }
  if (change.move !== undefined) {
    const j = change.move === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return finish(app, repo, edit.value, list, change.caption !== undefined ? "captioned" : "moved");
}

/** Take one screenshot off the pin. */
export async function removeShot(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  file: string,
  at?: string,
): Promise<Result<Shots, ShotsError>> {
  const edit = await begin(app, actor, repo, label, at);
  if (!edit.ok) return edit;
  const i = edit.value.shots.items.findIndex((s) => s.file === file);
  if (i === -1) return err("no_such_shot");
  return finish(app, repo, edit.value, kept(edit.value.shots).filter((_, k) => k !== i), "removed");
}
