/**
 * The files that grow by pure appends: `bun scripts/append-growth.ts
 * [--days 7] [--min 10]` reads `git log --numstat` on the current branch and
 * prints, worst first, each file whose commits in the window only added
 * lines (none deleted) more than `--min` times. Append-only registries are
 * where pulls collide; each should become one file per entry.
 */

export type Row = { commit: string; added: number; deleted: number; path: string };
export type Growth = { path: string; count: number };

/** Parse `git log --numstat --format=%x00%H` output; binary rows are skipped. */
export function parseNumstat(text: string): Row[] {
  const rows: Row[] = [];
  for (const block of text.split("\0")) {
    const [commit, ...lines] = block.split("\n");
    if (!commit) continue;
    for (const line of lines) {
      const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
      if (m) rows.push({ commit, added: Number(m[1]), deleted: Number(m[2]), path: m[3]! });
    }
  }
  return rows;
}

/** Files every touching commit only added to, in more than `min` commits, worst first. */
export function appendGrowth(rows: readonly Row[], min: number): Growth[] {
  const seen = new Map<string, { commits: Set<string>; pure: boolean }>();
  for (const row of rows) {
    const file = seen.get(row.path) ?? { commits: new Set(), pure: true };
    if (row.deleted > 0) file.pure = false;
    else if (row.added > 0) file.commits.add(row.commit);
    seen.set(row.path, file);
  }
  return [...seen]
    .filter(([, f]) => f.pure && f.commits.size > min)
    .map(([path, f]) => ({ path, count: f.commits.size }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

/** A non-negative integer from an argument, or null. */
export function integer(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,6}$/.test(value) ? Number(value) : null;
}

export function parseArgs(argv: readonly string[]): { days: number; min: number } | null {
  let days = 7;
  let min = 10;
  for (let i = 0; i < argv.length; i += 2) {
    const n = integer(argv[i + 1]);
    if (n === null) return null;
    if (argv[i] === "--days") days = n;
    else if (argv[i] === "--min") min = n;
    else return null;
  }
  return { days, min };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: bun scripts/append-growth.ts [--days N] [--min N]  (integers)");
    process.exit(2);
  }
  const git = Bun.spawnSync(
    ["git", "log", "--numstat", "--no-renames", "--format=%x00%H", `--since=${args.days}.days.ago`],
    { cwd: new URL("..", import.meta.url).pathname, maxBuffer: 1 << 28 },
  );
  if (git.exitCode !== 0) {
    console.error(git.stderr.toString());
    process.exit(1);
  }
  const found = appendGrowth(parseNumstat(git.stdout.toString()), args.min);
  for (const f of found) console.log(`${f.count}\t${f.path}`);
  if (found.length === 0)
    console.log(`no file grew by pure appends in more than ${args.min} commits in ${args.days} days`);
}
