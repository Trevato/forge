/** The feed cards' slice of the served stylesheet (no imports: `style.ts` reads this). */

export const feedCss = /* css */ `
/* A timeline of the design system's cards; the card's own margin spaces them. */
.feed { display: grid; gap: 0; }
.feed > .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* The held-posts button sticks under the topbar so it is in sight while the reader is down the feed; the paragraph is zero-high until the button shows. */
.new-posts { position: sticky; top: calc(var(--topbar-h) + 8px); z-index: 9; margin: 0; display: flex; justify-content: center; pointer-events: none; }
.new-posts .btn { pointer-events: auto; min-height: 44px; box-shadow: var(--shadow-2); }
.new-posts .btn[hidden] { display: none; }
.feed > .card[hidden] { display: none; }
/* The Like form sits in the card's flow; its count has a fixed width so a press moves nothing. */
.feed .like { display: inline-block; margin: 0; }
.feed .like [data-likes] { display: inline-block; min-width: 3ch; text-align: end; font-variant-numeric: tabular-nums; }
.feed .card-foot > details { flex: 1 1 100%; }
/* Your apps: a narrow column on a desk, a tab away on a phone. */
/* An admin's tick boxes are always shown (no Select toggle); 24 px to tap. */
#live-apps input[type="checkbox"] { width: 24px; height: 24px; }
@media (max-width: 899px) {
  #live-apps { display: none; }
}
.tell-box > input[name="text"] { flex: 1 1 14rem; min-width: 0; }
@media (max-width: 600px) {
  .feed .bar .btn { padding: 8px 10px; }
  .feed .disclosure > summary { min-height: 44px; display: flex; align-items: center; }
}
@media (forced-colors: active) {
  .feed > .card:focus-visible { outline: 2px solid Highlight; }
}
`;
