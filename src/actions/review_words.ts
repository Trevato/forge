/**
 * The refusals of a review, in words (#5565): the pull page, the studio's
 * review action and MCP's `review` tool all say them, and each reads them
 * from here so the doors cannot drift. Plain strings, no logic.
 */
export const reviewWords = {
  /** `self_review`: an author cannot approve their own change. */
  selfReview: "You cannot approve your own pull request.",
  /** `body_too_long`: the review's body is over 64 KB. */
  tooLong: "That review is too long (64 KB at most).",
  /** `forbidden`: a reader cannot pass a verdict that gates a merge. */
  forbidden: "A verdict that gates a merge needs write access.",
  /** `looks_required`: a stylesheet change is approved beside the home page's looks. */
  looksRequired:
    "This pull changes a stylesheet: wait for its preview's phone and desktop looks of the home page (beside main's on the pull page), then approve.",
} as const;
