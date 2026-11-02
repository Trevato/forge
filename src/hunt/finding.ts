/** What a detector says: plain data, one issue per `key` (the sentinel's rule). */

export interface Finding {
  detector: string;
  /** Stable across runs: the same defect has the same key, so it files once. */
  key: string;
  title: string;
  /** The minimal repro: the request and what came back. */
  evidence: string;
}

export const found = (detector: string, subject: string, title: string, evidence: string): Finding => ({
  detector,
  key: `${detector}:${subject}`,
  title,
  evidence,
});

export const seenLine = (path: string, status: number, location?: string | null): string =>
  `GET ${path} → ${status}${location ? ` → ${location}` : ""}`;

/**
 * What a finding is, so it is filed already sorted (#8856): a security hole is
 * a `high` bug (the 4 h clock in `flow/bugs.ts`), any other defect a bug (48 h).
 * A kind joins this list with the first detector that files it.
 */
export type FindingKind = "security" | "defect";

export const KIND_LABELS: Readonly<Record<FindingKind, readonly string[]>> = {
  security: ["bug", "high"],
  defect: ["bug"],
};

/** Each label a kind is filed with, and the colour it is made in when the repository has none by that name. */
export const LABEL_COLORS: Readonly<Record<string, string>> = {
  bug: "d73a4a",
  high: "b60205",
};
