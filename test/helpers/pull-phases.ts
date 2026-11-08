/** The Server-Timing phases an open pull's page names after `app`, in order (#8389). */
export const PULL_PAGE_PHASES = [
  "session", "diff", "checks", "tells", "preview", "head", "gate", "decide", "looks", "reviews", "render",
] as const;
