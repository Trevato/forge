/**
 * Slots for code greps. A `git grep` outlives the search that started it (a
 * search that returns at its budget leaves its greps running for up to the
 * grep timeout), so the slot is held until the grep settles, not until the
 * search answers. Forge-wide there are `total`; signed-out callers together
 * hold at most `strangers`; each member holds at most `perMember`, keyed on
 * the actor's id and on nothing a client sends. Members together never take
 * the strangers' share (`total - strangers`), so signed-in load cannot starve
 * the strangers' promised slots.
 */

export interface GrepLimits {
  readonly total: number;
  readonly strangers: number;
  readonly perMember: number;
}

export const GREP_LIMITS: GrepLimits = { total: 8, strangers: 4, perMember: 2 };

export interface GrepSlots {
  /**
   * Run `grep` in a slot for `memberId` (undefined: a stranger). Resolves
   * `{ ran: false }` without starting it when no slot is free; otherwise the
   * slot is freed when `grep` settles, however it settles.
   */
  run<T>(
    memberId: string | undefined,
    grep: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }>;
  /** Slots held now, for tests and diagnostics. */
  held(): { total: number; strangers: number };
}

export function createGrepSlots(limits: GrepLimits = GREP_LIMITS): GrepSlots {
  let total = 0;
  let strangers = 0;
  let membersHeld = 0;
  const members = new Map<string, number>();

  return {
    async run(memberId, grep) {
      if (total >= limits.total) return { ran: false };
      if (memberId === undefined) {
        if (strangers >= limits.strangers) return { ran: false };
        strangers++;
      } else {
        const mine = members.get(memberId) ?? 0;
        if (mine >= limits.perMember) return { ran: false };
        if (membersHeld >= limits.total - limits.strangers) return { ran: false };
        membersHeld++;
        members.set(memberId, mine + 1);
      }
      total++;
      try {
        return { ran: true, value: await grep() };
      } finally {
        total--;
        if (memberId === undefined) strangers--;
        else {
          membersHeld--;
          const left = (members.get(memberId) ?? 1) - 1;
          if (left <= 0) members.delete(memberId);
          else members.set(memberId, left);
        }
      }
    },
    held: () => ({ total, strangers }),
  };
}

/** The forge's one set of slots. */
export const grepSlots: GrepSlots = createGrepSlots();
