/**
 * What sealing or unsealing an issue says (#7996): one place, so the issue
 * page's Seal form and the terminal's issue screen `S` read the same.
 */

import type { AccessError } from "./access.ts";
import type { MirrorError } from "./issues.ts";

export const SEAL_ISSUE_SAYS = {
  sealed: "Sealed: only people who can write here and the crew see it now.",
  unsealed: "Unsealed: everyone who can read this repository sees it now.",
  mirrored:
    "A mirror's issues live on its origin, in the open: nothing here can be sealed.",
  forbidden: "Only someone who can write here seals or unseals.",
} as const;

/** The sentence a seal or unseal said, in the issue page's words. */
export function sealedWords(sealed: boolean): string {
  return sealed ? SEAL_ISSUE_SAYS.sealed : SEAL_ISSUE_SAYS.unsealed;
}

/** A refusal from `setIssueSealed`, in the issue page's words. */
export function sealRefusedWords(error: AccessError | MirrorError): string {
  return error === "mirrored" ? SEAL_ISSUE_SAYS.mirrored : SEAL_ISSUE_SAYS.forbidden;
}
