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
