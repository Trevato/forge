/** The packages a repository pins, read from its package.json text (#9434). */

export interface Pin {
  readonly name: string;
  /** What package.json asks for, as written. */
  readonly range: string;
  /** The exact version it asks for, or "" when the range names none (`latest`, a URL, a tag). */
  readonly version: string;
  readonly dev: boolean;
}

/** An npm package name; anything else is never sent to a registry. */
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;

const FLOOR = /^[\^~>=\s]*v?(\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?)$/;

export function readPins(packageJson: string): Pin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const out: Pin[] = [];
  for (const [field, dev] of [["dependencies", false], ["devDependencies", true]] as const) {
    const block = (parsed as Record<string, unknown>)[field];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range !== "string" || !NPM_NAME.test(name)) continue;
      out.push({ name, range, version: FLOOR.exec(range)?.[1] ?? "", dev });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
