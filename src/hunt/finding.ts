/** What a detector says: plain data, one issue per `key` (the sentinel's rule). */

/**
 * What a finding is, so it is filed already sorted (#8856): a security hole or
 * a route that answers broken is a `high` bug (the 4 h clock in
 * `flow/bugs.ts`), any other defect a bug (48 h), and a cosmetic one `polish`.
 */
export type FindingKind = "security" | "broken-route" | "defect" | "cosmetic";

export const KIND_LABELS: Readonly<Record<FindingKind, readonly string[]>> = {
  security: ["bug", "high"],
  "broken-route": ["bug", "high"],
  defect: ["bug"],
  cosmetic: ["polish"],
};

/** Each label a kind is filed with, and the colour it is made in when the repository has none by that name. */
export const LABEL_COLORS: Readonly<Record<string, string>> = {
  bug: "d73a4a",
  high: "b60205",
  polish: "c5def5",
};

/**
 * Every detector that files through `found`, and its kind (#8969). A detector
 * not in this table is not a `Detector`, so `found` refuses it at the type check.
 */
export const DETECTOR_KINDS = {
  // An anonymous visitor who is not sent to sign-in may be reading a person's page.
  "door.signin-redirect": "security",
  "door.signin-next": "defect",
  "door.public-page": "broken-route",
  "door.unknown-404": "defect",
  "links.status": "broken-route",
  "links.lands-home": "cosmetic",
  "contract.openapi": "defect",
  "contract.no-500": "broken-route",
  "contract.documented": "defect",
  "performance-watcher": "defect",
} as const satisfies Record<string, FindingKind>;

export type Detector = keyof typeof DETECTOR_KINDS;

export interface Finding {
  detector: Detector;
  /** How it is filed: its labels, and so its clock. */
  kind: FindingKind;
  /** Stable across runs: the same defect has the same key, so it files once. */
  key: string;
  title: string;
  /** The minimal repro: the request and what came back. */
  evidence: string;
}

export const found = (detector: Detector, subject: string, title: string, evidence: string): Finding => ({
  detector,
  kind: DETECTOR_KINDS[detector],
  key: `${detector}:${subject}`,
  title,
  evidence,
});

export const seenLine = (path: string, status: number, location?: string | null): string =>
  `GET ${path} → ${status}${location ? ` → ${location}` : ""}`;
