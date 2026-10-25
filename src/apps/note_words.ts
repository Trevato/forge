/**
 * What sending a note says back (#5616), from one place: the note door
 * (`apps/feedback.ts`), the notes action (`actions/app_notes.ts`), the
 * forge pill's script (`apps/toolbar.ts`), the toolbar's forge page
 * (`web/studio/toolbar.ts`) and the terminal's report (`tui/screens/report.ts`).
 * Plain strings, so the web and the terminal say it the same way.
 */

/** A note with nothing in it. */
export const NOTE_EMPTY = "Write a few words first.";

/** A note that failed on the way, for a reason the sender cannot fix. */
export const NOTE_FAILED = "That did not go through. Try again.";

/** A note longer than one issue body may be. */
export const NOTE_TOO_LONG = "That is too long to send in one go.";
