/**
 * The standards this forge implements, by name and version: the one list
 * `/.well-known/forge` serves, `docs/standards/` has a page for each of, and
 * the conformance suite in `standards/` tests. A change that breaks an
 * earlier version of a standard is a new version here and a new page
 * revision there, never an edit in place (docs/standards/README.md).
 */

export type StandardEntry = {
  /** The page's file name without `.md`, and the standard's id. */
  readonly id: string;
  readonly title: string;
  /** A whole number; it rises only when an earlier version would stop passing. */
  readonly version: number;
};

export const STANDARDS: readonly StandardEntry[] = [
  { id: "app-manifest", title: "App manifest: forge.json and its life cycle", version: 1 },
  { id: "identity", title: "Identity: the signed headers an app verifies", version: 1 },
  { id: "permissions", title: "Permissions: contract.json", version: 1 },
  { id: "feedback", title: "Feedback: app notes and reports become issues", version: 1 },
  { id: "adapters", title: "Adapters: POST /pull", version: 1 },
];

/** The document at `/.well-known/forge`: plain data (`page` is a path in the forge's own repository), nothing about this forge's people or repositories. */
export function forgeDocument(version: string) {
  return {
    forge: { name: "forge", version },
    standards: STANDARDS.map((s) => ({
      id: s.id,
      version: s.version,
      title: s.title,
      page: `docs/standards/${s.id}.md`,
    })),
  };
}
