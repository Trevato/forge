/**
 * What a label change is told when it is refused, from every door: the
 * settings form and MCP `repo_labels` read it here, so they cannot drift.
 */

export const LABEL_WORDS = {
  shape: "A label needs a name and a six-digit hex color.",
  taken: "This repository already has a label by that name.",
  gone: "That label no longer exists.",
} as const;
