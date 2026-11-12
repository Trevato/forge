/**
 * A `package.json` as its manifest: name and version, the facts in one line
 * (`type`, `engines`, `license`), then scripts, dependencies, devDependencies
 * and peer/optional dependencies as rows. Source is one tap away.
 * Pure over the text; a file that is not a JSON object is not drawn at all
 * (`parsePackage` returns undefined and `rendererFor` declines it: the source view, no banner);
 * so is a manifest with nothing to list.
 * Every cell is escaped by the template; at most `ROW_CAP` rows per section.
 */

import { html, type Html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export const ROW_CAP = 500;

export interface PackageSection {
  readonly title: string;
  /** Name and value (a command, or a version range), in the file's order. */
  readonly rows: readonly (readonly [string, string])[];
  /** Entries in the file, drawn or not. */
  readonly total: number;
}

export interface PackageDoc {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** `type: module`, `node >=20`, `MIT`: the one-line facts. */
  readonly facts: readonly string[];
  readonly sections: readonly PackageSection[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The string-valued entries of an object field; anything else is skipped. */
function section(title: string, v: unknown): PackageSection | undefined {
  if (!isObject(v)) return undefined;
  const all = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string");
  if (all.length === 0) return undefined;
  return { title, rows: all.slice(0, ROW_CAP), total: all.length };
}

/** Read a manifest. Pure; never throws; undefined when the text is not a JSON object. */
export function parsePackage(source: string): PackageDoc | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  const facts: string[] = [];
  if (typeof raw["type"] === "string") facts.push(`type ${raw["type"]}`);
  if (isObject(raw["engines"]))
    for (const [k, v] of Object.entries(raw["engines"])) if (typeof v === "string") facts.push(`${k} ${v}`);
  if (typeof raw["license"] === "string") facts.push(raw["license"]);
  if (typeof raw["packageManager"] === "string") facts.push(raw["packageManager"]);
  const sections = [
    section("Scripts", raw["scripts"]),
    section("Dependencies", raw["dependencies"]),
    section("Dev dependencies", raw["devDependencies"]),
    section("Peer dependencies", raw["peerDependencies"]),
    section("Optional dependencies", raw["optionalDependencies"]),
  ].filter((s): s is PackageSection => s !== undefined);
  const name = str(raw["name"]);
  // Nothing to show as rows: the source view, on the web and in the terminal alike.
  if (name === "" && facts.length === 0 && sections.length === 0) return undefined;
  return { name, version: str(raw["version"]), description: str(raw["description"]), facts, sections };
}

/**
 * The manifest in a file's bytes, parsed once per body: `rendererFor` asks it
 * whether to draw at all (no: the source view, with no banner), and the
 * renderer is then handed the same bytes and reads the same answer.
 */
const parsed = new WeakMap<Uint8Array, PackageDoc | null>();
export function readPackage(body: Uint8Array): PackageDoc | undefined {
  let doc = parsed.get(body);
  if (doc === undefined) {
    doc = parsePackage(new TextDecoder().decode(body)) ?? null;
    parsed.set(body, doc);
  }
  return doc ?? undefined;
}

export function packageJson(input: RenderInput): Rendered {
  const doc = readPackage(input.body);
  // Only reached when called directly: `rendererFor` declines such a file first.
  if (doc === undefined) return { content: html``, lines: 0, fallback: "This file is not a JSON object to draw." };
  const scripts = (s: PackageSection): boolean => s.title === "Scripts";
  const blocks: Html[] = doc.sections.map((s) => {
    const rows = s.rows.map(([k, v]) =>
      scripts(s)
        ? html`<tr><th scope="row"><code>${k}</code></th><td><code>${v}</code></td></tr>`
        : html`<tr><th scope="row" class="break">${k}</th><td><code class="break">${v}</code></td></tr>`,
    );
    const more = s.total - s.rows.length;
    return html`<h3>${s.title}</h3><div class="table-scroll"><table class="table" data-dense aria-label="${s.title}"><thead><tr><th scope="col">Name</th><th scope="col">${scripts(s) ? "Command" : "Range"}</th></tr></thead><tbody>${rows}</tbody></table></div>${more > 0 ? html`<p class="muted small">${more} more not shown</p>` : html``}`;
  });
  const title = doc.name === "" ? "package.json" : doc.version === "" ? doc.name : `${doc.name} ${doc.version}`;
  const content = html`<div class="package-view"><h2>${title}</h2>${doc.description !== "" ? html`<p>${doc.description}</p>` : html``}${doc.facts.length > 0 ? html`<p class="muted small">${doc.facts.join(" · ")}</p>` : html``}${blocks}</div>`;
  const n = doc.sections.reduce((a, s) => a + s.total, 0);
  return { content, lines: 0, summary: `${n} ${n === 1 ? "entry" : "entries"} · ${fileSize(input.size)}` };
}
