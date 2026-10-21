/** The feed cards' slice of the served stylesheet (no imports: `style.ts` reads this). */

export const feedCss = /* css */ `
/* A timeline of the design system's cards; the card's own margin spaces them. */
.feed { display: grid; gap: 0; }
.feed > .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.feed > .card[hidden] { display: none; }
.feed .card-foot > details { flex: 1 1 100%; }
.fcard-reason { margin: 0 0 4px; font-size: 1.05em; overflow-wrap: anywhere; }
.fcard-text { white-space: pre-wrap; }
/* The planner's reply sits under the thought, indented, one or two lines. */
.fcard-reply { margin: 4px 0 0 12px; padding-left: 10px; border-left: 2px solid var(--border); overflow-wrap: anywhere; }
.fcard-unblock { display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; margin: 0; }
.fcard-unblock span { flex: 1 1 16ch; min-width: 0; overflow-wrap: anywhere; }
.fcard-who { font-weight: 600; }
.fcard-why { margin: 0 0 4px; }
/* The composer: the home's one primary action, on top of the timeline. */
.composer { display: grid; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card, var(--bg)); }
.composer textarea { width: 100%; min-height: 64px; resize: vertical; }
.composer-bar { display: flex; align-items: center; gap: 8px; min-width: 0; }
.composer-bar select { min-width: 0; max-width: 60%; }
/* Your apps: a narrow column on a desk, a tab away on a phone. */
/* An admin's tick boxes are always shown (no Select toggle); 24 px to tap. */
#live-apps input[type="checkbox"] { width: 24px; height: 24px; }
@media (max-width: 899px) {
  /* "What you asked for" is a tab on a phone: the first post comes next.
     !important, as [hidden] is: .bar sits in a later cascade layer. */
  .feed-head { display: none !important; }
  #live-apps { display: none; }
}
.fcard-form { display: grid; gap: 8px; margin-top: 6px; }
.fcard-form textarea { width: 100%; min-height: 56px; resize: vertical; }
@media (max-width: 600px) {
  .feed .bar .btn { padding: 8px 10px; }
  .feed .disclosure > summary { min-height: 44px; display: flex; align-items: center; }
}
@media (forced-colors: active) {
  .feed > .card:focus-visible { outline: 2px solid Highlight; }
}
`;
