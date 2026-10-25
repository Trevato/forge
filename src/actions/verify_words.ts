/**
 * What a person asking for another email-verification link is told when it
 * is refused, keyed by the refusal. Every door — POST
 * /api/v1/user/email/verify and the MCP `email_verify` tool — reads its
 * sentence from here, so the doors cannot drift apart.
 */
export const VERIFY_WORDS = {
  too_soon: "a link was sent a moment ago; check your inbox, or try again in a few minutes",
  failed: "the link could not be sent; try again",
  no_mail: "this forge sends no mail yet; ask its owner to verify you",
} as const;
