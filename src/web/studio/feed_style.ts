/** The feed cards' slice of the served stylesheet (no imports: `style.ts` reads this). */

export const feedCss = /* css */ `
/* A timeline of the design system's cards; the card's own margin spaces them. */
.feed { display: grid; gap: 0; }
.feed > .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.feed > .card[hidden] { display: none; }
.feed .card-foot > details { flex: 1 1 100%; }
/* The composer: the home's one primary action, on top of the timeline. */
.composer { display: grid; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card, var(--bg)); }
.composer textarea { width: 100%; min-height: 64px; resize: vertical; }
/* Your apps: a narrow column on a desk, a tab away on a phone. */
/* An admin's tick boxes are always shown (no Select toggle); 24 px to tap. */
#live-apps input[type="checkbox"] { width: 24px; height: 24px; }
@media (max-width: 899px) {
  /* "What you asked for" is a tab on a phone: the first post comes next.
     !important, as [hidden] is: .bar sits in a later cascade layer. */
  .feed-head { display: none !important; }
  #live-apps { display: none; }
}
@media (max-width: 600px) {
  .feed .bar .btn { padding: 8px 10px; }
  .feed .disclosure > summary { min-height: 44px; display: flex; align-items: center; }
}
@media (forced-colors: active) {
  .feed > .card:focus-visible { outline: 2px solid Highlight; }
}
`;
