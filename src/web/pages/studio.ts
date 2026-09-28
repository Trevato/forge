/**
 * The studio's old front door. Every page and every word moved to
 * `web/studio/`, one module per concept — `words` (the vocabulary and its
 * badge), `asks`/`leans` (what asks a person, and the decider's lean on it),
 * `previews`, `home`, `app`, `change`, `tell`, `run`, `lists`, `actions` and
 * `style`. Nothing renders here any more: this file exists so the tests that
 * prove the move changed no byte of HTML could stay untouched while it
 * happened. Import the module you need; nothing new belongs here.
 */

export { decisionsFor } from "../studio/asks.ts";
export {
  pullWord,
  runWord,
  servingHistory,
  type WordCtx,
} from "../studio/words.ts";
