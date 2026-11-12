/**
 * A vision thought proposes its own edit (#5833): a small pull to
 * docs/VISION.md adding one dated line under `Changes of direction`. It only
 * proposes; a person lands it, and landing it changes no setting. The pull is
 * recorded on the placement (`placed[].pull`, action `proposed`), which is what
 * marks it as a vision pull, never its branch name.
 */

import type { App } from "../app.ts";
import { isVisionPull } from "../core/placements.ts";
import { NO_VISION, parseVision, type Vision } from "../core/vision.ts";
import { directionStall } from "./planner.ts";
import { runGit } from "../git/env.ts";
import { getPull } from "../core/pulls.ts";
import { canAdmin, getRepoById, updateRepoSettings } from "../core/repos.ts";
import { createLog } from "../kernel/log.ts";
import { editFiles } from "../actions/contents.ts";
import { pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { settingMoved } from "../core/settings_changed.ts";
import type { User } from "../core/users.ts";
import { blobForRender, listTree, readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { clip } from "../text/clip.ts";

const log = createLog("vision");

export const VISION_PATH = "docs/VISION.md";
export const SECTION = "Changes of direction";
const LINE_SHOWN = 240;

/** The line a thought adds: one flat, dated bullet that carries the thought's id. */
export function directionLine(text: string, id: string, now: Date): string {
  return `- ${now.toISOString().slice(0, 10)}: ${clip(text, LINE_SHOWN)} (thought \`${id}\`)`;
}

/** `current` with `line` last under the `Changes of direction` section, made when missing. `current` null means no file. */
export function withDirection(current: string | null, line: string): string {
  if (current === null) return `# Vision\n\n## ${SECTION}\n${line}\n`;
  const lines = current.replace(/\n+$/, "").split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s+/.test(l) && l.replace(/^#+\s+/, "").trim().toLowerCase() === SECTION.toLowerCase());
  if (at < 0) return `${lines.join("\n")}\n\n## ${SECTION}\n${line}\n`;
  const level = /^#+/.exec(lines[at]!)![0].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const h = /^(#+)\s/.exec(lines[i]!);
    if (h && h[1]!.length <= level) {
      end = i;
      break;
    }
  }
  const next = end;
  while (end > at + 1 && lines[end - 1]!.trim() === "") end--;
  const tail = next < lines.length ? ["", ...lines.slice(next)] : [];
  return `${[...lines.slice(0, end), line, ...tail].join("\n")}\n`;
}

/** The document's cap: a bigger VISION.md is read as none. */
const VISION_MAX_BYTES = 1_000_000;

/**
 * docs/VISION.md on the default branch, parsed; null when it is absent, not
 * text or over the cap. The one read MCP `vision` and the terminal's Vision
 * screen both make, so the cap and the fallback cannot drift apart.
 */
export async function readDefaultVision(reposRoot: string, repo: Repo): Promise<Vision | null> {
  const dir = repoDir(reposRoot, repo.ownerName, repo.name);
  const blob = await blobForRender(dir, repo.defaultBranch, VISION_PATH, VISION_MAX_BYTES);
  return blob.kind === "text" ? parseVision(new TextDecoder().decode(blob.body)) : null;
}

/**
 * What MCP `vision` and `GET /api/v1/repos/:owner/:name/vision` both answer.
 * `direction`, `directionStall`, `directionParts` and `preview` are admin-only
 * (null otherwise); `number` names an open vision pull to preview.
 */
export async function answerVision(app: App, user: User | undefined, repo: Repo, number?: number) {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const read = await readDefaultVision(app.reposRoot, repo);
  const vision = read ?? NO_VISION;
  const last = read !== null ? await runGit(["log", "-1", "--format=%cI", repo.defaultBranch, "--", VISION_PATH], { cwd: dir }) : undefined;
  const admin = canAdmin(app.db, repo, user);
  const pull = admin && number !== undefined ? getPull(app.db, repo.id, number) : undefined;
  const shown = pull ? await previewVision(app, repo, pull) : null;
  return {
    ...vision,
    direction: admin ? repo.autonomyDirection : null,
    directionStall: admin ? directionStall(app, repo) : null,
    directionParts: admin ? directionParts(repo.autonomyDirection) : null,
    preview: shown === null ? null : shown.ok ? { today: shown.today, after: shown.after } : { why: shown.why },
    updatedAt: last?.ok && last.value.trim() ? last.value.trim() : null,
  };
}

async function readVision(app: App, repo: Repo): Promise<string | null> {
  return readVisionAt(repoDir(app.reposRoot, repo.ownerName, repo.name), repo.defaultBranch);
}

async function readVisionAt(dir: string, rev: string): Promise<string | null> {
  const tree = await listTree(dir, rev, "docs");
  const entry = tree.ok ? tree.value.find((e) => e.type === "blob" && e.name === "VISION.md") : undefined;
  if (!entry) return null;
  const obj = await readerFor(dir).object(entry.oid);
  return obj.ok ? new TextDecoder().decode(obj.value.body) : null;
}

/** Open the pull for a vision thought, or say why not. */
export async function proposeVision(
  app: App,
  by: User,
  repo: Repo,
  thought: { id: string; text: string },
  now = new Date(),
): Promise<{ ok: true; pull: Pull } | { ok: false; why: string }> {
  const line = directionLine(thought.text, thought.id, now);
  const quoted = thought.text.split("\n").map((l) => `> ${l}`).join("\n");
  const edited = await editFiles(app, by, repo, {
    newBranch: `vision-${thought.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
    message: "Note a change of direction",
    files: [{ path: VISION_PATH, content: withDirection(await readVision(app, repo), line) }],
    openPull: {
      title: "Note a change of direction in docs/VISION.md",
      body: `Adds one line under \`${SECTION}\`. Landing it changes no setting.\n\nFrom thought \`${thought.id}\`:\n\n${quoted}`,
    },
  });
  if (!edited.ok || !edited.value.pull) return { ok: false, why: "the edit could not be opened" };
  return { ok: true, pull: edited.value.pull };
}

/** The fenced block's markers; the owner's words outside them are never touched. */
export const BLOCK_START = "<!-- forge:vision:start -->";
export const BLOCK_END = "<!-- forge:vision:end -->";
export const DIRECTION_LIMIT = 2000;

/** `clip`, never leaving a space before its "…". */
const clipTight = (s: string, n: number): string => clip(s, n).replace(/ …$/, "…");

/** The block for a vision, markers included, no longer than `room` characters; null when not even its head fits. */
export function visionBlock(vision: Vision, room = DIRECTION_LIMIT): string | null {
  const parts: string[] = [];
  if (vision.purpose) parts.push(`Purpose: ${clipTight(vision.purpose, 400)}`);
  if (vision.order.length > 0) parts.push(`Order of work: ${vision.order.map((o) => `${o.n}. ${o.name}`).join("; ")}.`);
  for (const rule of vision.rules) parts.push(`Rule: ${clipTight(rule, 160)}`);
  const kept: string[] = [];
  for (const part of parts) {
    const next = `${BLOCK_START}\n${[...kept, part].join("\n")}\n${BLOCK_END}`;
    if (next.length > room) break;
    kept.push(part);
  }
  return kept.length === 0 ? null : `${BLOCK_START}\n${kept.join("\n")}\n${BLOCK_END}`;
}

const count = (s: string, needle: string): number => s.split(needle).length - 1;

/**
 * `direction` with the fenced block regenerated, everything outside it kept
 * byte for byte. No block yet: it is appended after the owner's words. An
 * orphan, doubled or reversed marker changes nothing and says why.
 */
export function withVisionBlock(
  direction: string,
  vision: Vision,
): { ok: true; text: string } | { ok: false; why: string } {
  const starts = count(direction, BLOCK_START);
  const ends = count(direction, BLOCK_END);
  const from = direction.indexOf(BLOCK_START);
  const to = direction.indexOf(BLOCK_END);
  if (starts !== ends || starts > 1) return { ok: false, why: "the start and end markers do not pair up" };
  if (starts === 1 && to < from) return { ok: false, why: "the end marker comes before the start marker" };
  if (starts === 0) {
    const sep = direction === "" ? "" : direction.endsWith("\n\n") ? "" : direction.endsWith("\n") ? "\n" : "\n\n";
    const block = visionBlock(vision, DIRECTION_LIMIT - direction.length - sep.length);
    return block === null ? { ok: false, why: "the owner's words leave no room for the block" } : { ok: true, text: `${direction}${sep}${block}` };
  }
  const before = direction.slice(0, from);
  const after = direction.slice(to + BLOCK_END.length);
  const block = visionBlock(vision, DIRECTION_LIMIT - before.length - after.length);
  return block === null ? { ok: false, why: "the owner's words leave no room for the block" } : { ok: true, text: `${before}${block}${after}` };
}

/** What the direction becomes when `md` is the landed VISION.md: the one function both the merge and the preview call. */
export function nextDirection(direction: string, md: string): ReturnType<typeof withVisionBlock> {
  return withVisionBlock(direction, parseVision(md));
}

export interface DirectionPart {
  readonly kind: "vision" | "owner";
  readonly text: string;
}

/** The direction cut at its fenced block: the owner's words and the part that follows docs/VISION.md. Odd markers make it all the owner's. */
export function directionParts(direction: string): DirectionPart[] {
  const from = direction.indexOf(BLOCK_START);
  const to = direction.indexOf(BLOCK_END);
  const paired = count(direction, BLOCK_START) === 1 && count(direction, BLOCK_END) === 1 && to > from;
  const raw: DirectionPart[] = paired
    ? [
        { kind: "owner", text: direction.slice(0, from) },
        { kind: "vision", text: direction.slice(from, to + BLOCK_END.length) },
        { kind: "owner", text: direction.slice(to + BLOCK_END.length) },
      ]
    : [{ kind: "owner", text: direction }];
  return raw.filter((p) => p.text.trim() !== "").map((p) => ({ kind: p.kind, text: p.text.trim() }));
}

export type VisionPreview =
  | { readonly ok: true; readonly today: string; readonly after: string }
  | { readonly ok: false; readonly why: string };

/**
 * For an open vision pull: the direction as it stands and as the merge of
 * this pull (by an admin) will write it, from the VISION.md on its head.
 * Null for any other pull.
 */
export async function previewVision(app: App, repo: Repo, pull: Pull): Promise<VisionPreview | null> {
  if (pull.state !== "open" || pull.mergedAt !== null) return null;
  if (!isVisionPull(app.db, `${repo.ownerName}/${repo.name}`, pull.number)) return null;
  const md = await readVisionAt(await pullDir(app.db, app.reposRoot, repo, pull), pull.headOid);
  if (md === null) return { ok: false, why: "this pull has no docs/VISION.md" };
  const next = nextDirection(repo.autonomyDirection, md);
  return next.ok ? { ok: true, today: repo.autonomyDirection, after: next.text } : { ok: false, why: next.why };
}

/**
 * After a pull lands: when it is a vision pull (its placement says so, never
 * its branch name) and the merger administers the repository, regenerate the
 * fenced block of the direction from the landed VISION.md. Anyone else's merge
 * leaves the direction alone and writes a `repo` event the pull page shows.
 */
export async function landVision(app: App, merger: User, repo: Repo, pull: Pull): Promise<void> {
  if (!isVisionPull(app.db, `${repo.ownerName}/${repo.name}`, pull.number)) return;
  if (!canAdmin(app.db, repo, merger)) {
    app.bus.append({
      kind: "repo.vision_kept",
      repoId: repo.id,
      payload: { pull: pull.number, why: "an admin's merge rewrites it" },
    });
    return;
  }
  const fresh = getRepoById(app.db, repo.id) ?? repo;
  const md = await readVision(app, fresh);
  if (md === null) return;
  const next = nextDirection(fresh.autonomyDirection, md);
  if (!next.ok) {
    log.warn("left the direction unchanged", { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number, why: next.why });
    return;
  }
  if (next.text === fresh.autonomyDirection) return;
  updateRepoSettings(app.db, fresh, { autonomyDirection: next.text });
  app.bus.append({
    kind: "repo.settings_updated",
    repoId: repo.id,
    actorId: merger.id,
    payload: { changed: settingMoved("autonomyDirection", fresh.autonomyDirection, next.text), pull: pull.number },
  });
}
