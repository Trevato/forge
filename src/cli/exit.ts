/** The exit codes a script can branch on without parsing text. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  notConfigured: 3,
  /** The run completed, but at least one repo did not. */
  partial: 4,
  /** The forge heard the request and said no: a rule, a conflict, a hold. */
  refused: 5,
  /** The forge said "not now"; it named when to try again. */
  rateLimited: 6,
} as const;
