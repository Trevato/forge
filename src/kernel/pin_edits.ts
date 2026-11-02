/**
 * Pins are history: a migration on main is never edited, so neither is its
 * pin. `pinBreaks` cannot see a pull that edits a migration and its pin
 * together; the pull's diff to its base can.
 */

export type Change = {
  /** git's name-status letter: A, M, D, R, C or T. */
  status: string;
  path: string;
};

const PINS = "src/core/migration-pins/";
const FROZEN = "src/core/migration-pins.json";

/** The paths a pull may not touch: pins and the frozen pins file that it modified, deleted or renamed. */
export function pinEdits(changes: readonly Change[]): string[] {
  const edited = new Set<string>();
  for (const { status, path } of changes) {
    if (!path.startsWith(PINS) && path !== FROZEN) continue;
    if (status.startsWith("A") || status.startsWith("C")) continue;
    edited.add(path);
  }
  return [...edited];
}

/**
 * `git diff --name-status` output as changes. A rename is its old path
 * (renamed away) and its new path (added).
 */
export function parseNameStatus(out: string): Change[] {
  const changes: Change[] = [];
  for (const line of out.split("\n")) {
    const [status, a, b] = line.split("\t");
    if (!status || a === undefined) continue;
    if (status.startsWith("R") && b !== undefined) {
      changes.push({ status: "R", path: a }, { status: "A", path: b });
    } else changes.push({ status, path: a });
  }
  return changes;
}

const MIGRATIONS = "src/core/migrations/";

/**
 * The migrations a pull adds whose pin is missing (#6938): each added
 * `src/core/migrations/<name>.ts` for which `pinned(name)` is false.
 */
export function unpinnedAdds(
  changes: readonly Change[],
  pinned: (name: string) => boolean,
): string[] {
  const names: string[] = [];
  for (const { status, path } of changes) {
    if (!path.startsWith(MIGRATIONS) || !path.endsWith(".ts")) continue;
    if (!status.startsWith("A") && !status.startsWith("C")) continue;
    const name = path.slice(MIGRATIONS.length, -".ts".length);
    if (!name.includes("/") && !pinned(name)) names.push(name);
  }
  return names;
}
