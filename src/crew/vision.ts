/**
 * A vision thought proposes its own edit (#5833): a small pull to
 * docs/VISION.md adding one dated line under `Changes of direction`. It only
 * proposes; a person lands it, and landing it changes no setting. The pull is
 * recorded on the placement (`placed[].pull`, action `proposed`), which is what
 * marks it as a vision pull, never its branch name.
 */

import type { App } from "../app.ts";
import { editFiles } from "../actions/contents.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { listTree, readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";

export const VISION_PATH = "docs/VISION.md";
export const SECTION = "Changes of direction";
const LINE_SHOWN = 240;

/** The line a thought adds: one flat, dated bullet that carries the thought's id. */
export function directionLine(text: string, id: string, now: Date): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const said = flat.length > LINE_SHOWN ? `${flat.slice(0, LINE_SHOWN - 1)}…` : flat;
  return `- ${now.toISOString().slice(0, 10)}: ${said} (thought \`${id}\`)`;
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

async function readVision(app: App, repo: Repo): Promise<string | null> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tree = await listTree(dir, repo.defaultBranch, "docs");
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
