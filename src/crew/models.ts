/**
 * The models a person can put an agent on. Claude Code takes an alias or a
 * full id and the runner passes it through untouched; an alias names the
 * newest of its line, so the list does not age. Empty is the runner's own
 * default.
 */
export const MODELS: readonly { id: string; label: string }[] = [
  { id: "", label: "Default — the runner's" },
  { id: "opus", label: "Opus — the most capable" },
  { id: "sonnet", label: "Sonnet — capable and quick" },
  { id: "haiku", label: "Haiku — the quickest" },
];

/** The label for a model id, or the id itself when it is not on the list. */
export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
