// The words a door says about email verification. Every surface (page, API,
// MCP, terminal) reads them from here, so the sentence cannot drift between
// doors.

/** Refuses a create or a cost (an app, a tell, a token) to an unverified account. */
export const VERIFY_FIRST = "verify your email first";

/** Refuses making an app your own to an unverified account. */
export const PROVE_FIRST = "prove your email first";

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
