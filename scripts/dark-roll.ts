/**
 * A roll that cannot surge waits for the owner's yes to that one roll
 * (#1589, part of #1072).
 *
 * When the surge check (`scripts/roll.ts`) says the new pod does not fit,
 * the roll is dark for the seconds the old pod is gone before the new one
 * is ready. The release agent does not roll then. It reports those seconds
 * and the headroom that would avoid them, and waits for a yes naming the
 * version. The yes is recorded in `docs/ops/dark-rolls.log`, one line per
 * roll:
 *
 *   <version> yes <owner> <YYYY-MM-DD> [note…]
 *
 * A yes covers exactly the version it names: no wildcard, no prefix, no
 * "until further notice". Plain data in, plain data out.
 */

import type { Surge } from "./roll.ts";

export interface Yes {
  readonly version: string;
  readonly owner: string;
  readonly date: string;
}

const VERSION = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/;
const LINE = /^(\S+)[ \t]+yes[ \t]+(@?[A-Za-z0-9][A-Za-z0-9_.-]{0,38})[ \t]+(\d{4}-\d{2}-\d{2})(?:[ \t].*)?$/;

/** Is this a version the log can name (`0.7.104`, `v0.7.104-rc.1`)? */
export function isVersion(text: string): boolean {
  return VERSION.test(text);
}

/** The yeses in a log. Comments, blanks and anything malformed are not yeses. */
export function parseYeses(text: string): Yes[] {
  const out: Yes[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (m && isVersion(m[1]!)) out.push({ version: m[1]!, owner: m[2]!, date: m[3]! });
  }
  return out;
}

/** The line to append to the log when the owner has said yes to `version`. */
export function yesLine(version: string, owner: string, date: string): string {
  const line = `${version} yes ${owner} ${date}`;
  if (!isVersion(version) || LINE.exec(line) === null)
    throw new Error("a yes names one version, an owner and a YYYY-MM-DD date");
  return line;
}

export interface Decision {
  /** May the release agent roll this version? */
  readonly roll: boolean;
  /** Rolling dark, with the owner's yes. */
  readonly dark: boolean;
  readonly yes: Yes | null;
}

/**
 * Roll when a surge pod fits; otherwise only with a yes for exactly this
 * version. A yes for another version does not count.
 */
export function decide(surge: Pick<Surge, "fits">, version: string | null, yeses: readonly Yes[]): Decision {
  if (surge.fits) return { roll: true, dark: false, yes: null };
  const yes = version === null ? null : (yeses.find((y) => y.version === version) ?? null);
  return { roll: yes !== null, dark: yes !== null, yes };
}

/** The lines the release agent prints when it must wait for a yes. */
export function ask(surge: Surge, version: string | null, darkSeconds: number | null): string {
  const mib = Math.ceil(surge.shortfall.memory / 2 ** 20);
  const lines = [
    `NOT rolling${version ? ` ${version}` : ""}: no surge pod fits, so the roll would be dark` +
      (darkSeconds === null ? "." : ` for about ${darkSeconds}s.`),
    `headroom that avoids it: ${mib} MiB and ${surge.shortfall.milliCpu}m cpu more free on ${surge.node}`,
  ];
  lines.push(
    version
      ? `to roll dark anyway the owner must say yes to ${version} alone; record it: docs/ops/dark-rolls.log  "${version} yes <owner> <YYYY-MM-DD>"`
      : "to roll dark anyway, pass --version and the owner's yes to that version (docs/ops/ROLL.md, step 2)",
  );
  return lines.join("\n");
}
