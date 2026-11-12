/**
 * The /flow explanations that change no decision (#11170): said once, shown
 * behind the page's `?` and at the foot of the terminal's Flow screen.
 */
export const MERGE_QUEUE_HELP =
  "Green, approved pulls join their repository's queue; each candidate is gated once and lands whole, or is searched for the red one. Where check slots are free the next candidate gates on top of this one, and a red one's halves gate at once. A pull found red is re-checked alone before it rides with others again.";
