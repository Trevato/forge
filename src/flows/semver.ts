/** Semantic versions, compared without a library (#9434). Plain data in, plain data out. */

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: string;
}

export type Gap = "none" | "patch" | "minor" | "major";

const RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** The version in `text` (a leading `v` allowed), or undefined when it is not one. */
export function parseSemver(text: string): Semver | undefined {
  const m = RE.exec(text.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}

/** Negative when a < b, zero when equal, positive when a > b. A release outranks its prerelease. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** How far `latest` is ahead of `pinned`: none when it is the same or behind. */
export function gapOf(pinned: Semver, latest: Semver): Gap {
  if (compareSemver(latest, pinned) <= 0) return "none";
  if (latest.major !== pinned.major) return "major";
  if (latest.minor !== pinned.minor) return "minor";
  return "patch";
}
