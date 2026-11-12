/**
 * The app a new app starts as is a repository (#10305): `apps.template`
 * names it (default `trevato/app-template`), and New app copies its tracked
 * files at the default branch's tip — one commit, no history. Where the
 * forge has no such repository (a child forge, a pack forge, a fresh
 * install) the copy baked into the image is used: `templates/app-template.json`,
 * taken from the repository by `scripts/take-template.ts`.
 *
 * `template.json` in the template says which files carry the app's name and
 * description and the literals standing in for them; the forge replaces
 * those and leaves the rest byte for byte, so the template stays runnable
 * and its own tests pass as they are. `template.json` itself is not copied.
 */

import { readFileSync } from "node:fs";
import type { App } from "../app.ts";
import { DEFAULT_TEMPLATE } from "../core/app_templates.ts";
import { getRepo } from "../core/repos.ts";
import { listPaths, readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import type { FileWrite } from "../git/write.ts";
import { TEMPLATE_MAX_BYTES, TEMPLATE_MAX_FILE_BYTES, TEMPLATE_MAX_FILES } from "./template_tip.ts";

export const TEMPLATE_SETTING = "apps.template";

// The same caps as every other template copy (template_tip.ts).
const FILES_MAX = TEMPLATE_MAX_FILES;
const FILE_BYTES_MAX = TEMPLATE_MAX_FILE_BYTES;
const TOTAL_BYTES_MAX = TEMPLATE_MAX_BYTES;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface ScaffoldInput {
  /** The repository name; also the title on the page. */
  readonly name: string;
  /** What the app should become. Shown on the page until it does. */
  readonly description: string;
}

/** What `template.json` declares. */
export interface TemplateSpec {
  /** The literal standing in for the app's name. */
  readonly name: string;
  /** The literal standing in for its description (also the default one). */
  readonly description: string;
  /** The files that carry those literals. */
  readonly files: readonly string[];
}

/** A template as copied: its files, with `template.json` among them. */
export interface TemplateCopy {
  readonly files: readonly FileWrite[];
  /** Where it came from: `owner/name`, and the tip or pinned commit. */
  readonly from: string;
  readonly commit: string;
}

export const isTemplateSlug = (s: string): boolean => SLUG.test(s);

/** A safe relative path: no dot segments, no `.git`, no absolute or odd bytes. */
function safePath(path: string): boolean {
  if (path === "" || path.length > 300 || path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(path)) return false;
  return path.split("/").every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
}

/** Parse `template.json`; undefined when it is not what the forge reads. */
export function parseTemplateSpec(text: string): TemplateSpec | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { name, description, files } = raw as Record<string, unknown>;
  if (typeof name !== "string" || name === "" || name.length > 100) return undefined;
  if (typeof description !== "string" || description === "" || description.length > 500) return undefined;
  if (!Array.isArray(files) || files.length > 50) return undefined;
  if (!files.every((f) => typeof f === "string" && safePath(f))) return undefined;
  return { name, description, files: files as string[] };
}

const text = (f: FileWrite): string =>
  typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content ?? new Uint8Array());

/** A literal as it sits inside a JSON string. */
const jsonInner = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * Replace the declared literals in the declared files, once each, as plain
 * text (a `.json` file gets the JSON-escaped form). Everything else is the
 * template's own bytes. Undefined when the template has no readable
 * `template.json`.
 */
export function fillTemplate(copy: TemplateCopy, input: ScaffoldInput): FileWrite[] | undefined {
  const spec = copy.files.find((f) => f.path === "template.json");
  const parsed = spec === undefined ? undefined : parseTemplateSpec(text(spec));
  if (parsed === undefined) return undefined;
  const description = input.description.trim() || parsed.description;
  const carriers = new Set(parsed.files);
  const out: FileWrite[] = [];
  for (const f of copy.files) {
    if (f.path === "template.json") continue;
    if (!carriers.has(f.path) || f.content === null) {
      out.push(f);
      continue;
    }
    const json = f.path.endsWith(".json");
    const esc = (s: string): string => (json ? jsonInner(s) : s);
    // Description first: the name literal can sit inside it.
    const body = text(f)
      .split(esc(parsed.description))
      .join("\u0000D\u0000")
      .split(esc(parsed.name))
      .join(esc(input.name))
      .split("\u0000D\u0000")
      .join(esc(description));
    out.push({ ...f, content: body });
  }
  return out;
}

let baked: TemplateCopy | undefined;

/** The copy in the image. */
export function bakedTemplate(): TemplateCopy {
  if (baked) return baked;
  const raw = JSON.parse(
    readFileSync(new URL("../../templates/app-template.json", import.meta.url), "utf8"),
  ) as { repo: string; commit: string; pinned?: boolean; files: Record<string, string> };
  baked = {
    from: raw.repo,
    commit: raw.commit,
    files: Object.entries(raw.files).map(([path, content]) => ({ path, content })),
  };
  return baked;
}

/** The baked copy filled in for an app, synchronously. */
export function bakedFiles(input: ScaffoldInput): FileWrite[] {
  const files = fillTemplate(bakedTemplate(), input);
  if (!files) throw new Error("the baked app template has no readable template.json");
  return files;
}

/** The template this forge names, `owner/name`. */
export function templateSlug(app: App): string {
  const row = app.db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(TEMPLATE_SETTING);
  return row !== null && isTemplateSlug(row.value) ? row.value : DEFAULT_TEMPLATE;
}

/** The tracked files of `owner/name` at its default branch's tip, or undefined. */
export async function readTemplate(app: App, slug: string): Promise<TemplateCopy | undefined> {
  if (!isTemplateSlug(slug)) return undefined;
  const [owner, name] = slug.split("/") as [string, string];
  const repo = getRepo(app.db, owner, name);
  if (!repo) return undefined;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const rev = `refs/heads/${repo.defaultBranch}`;
  const listed = await listPaths(dir, rev, FILES_MAX + 1);
  if (!listed.ok || listed.value.truncated || listed.value.paths.length > FILES_MAX || listed.value.paths.length === 0)
    return undefined;
  const reader = readerFor(dir);
  const commit = await reader.stat(rev);
  if (!commit.ok) return undefined;
  const files: FileWrite[] = [];
  let total = 0;
  for (const path of listed.value.paths) {
    if (!safePath(path)) return undefined;
    const obj = await reader.object(`${rev}:${path}`);
    if (!obj.ok || obj.value.type !== "blob" || obj.value.body.length > FILE_BYTES_MAX) return undefined;
    total += obj.value.body.length;
    if (total > TOTAL_BYTES_MAX) return undefined;
    files.push({ path, content: obj.value.body });
  }
  return { files, from: slug, commit: commit.value.oid };
}

/**
 * The files for a new app: from the named template (default: the forge's),
 * else the baked copy. A repository whose `template.json` is missing or
 * unreadable is not a template, and the baked copy stands in.
 */
export async function scaffoldFiles(
  app: App,
  input: ScaffoldInput,
  slug: string = templateSlug(app),
): Promise<FileWrite[]> {
  const copy = await readTemplate(app, slug);
  return (copy && fillTemplate(copy, input)) ?? bakedFiles(input);
}
