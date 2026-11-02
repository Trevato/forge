/** The feed cards' slice of the served stylesheet (no imports: `style.ts` reads this). */

export const feedCss = /* css */ `
/* A timeline of the design system's cards; the card's own margin spaces them. */
.feed { display: grid; gap: 0; }
.feed > .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.feed > .card[hidden] { display: none; }
.feed .card-foot > details { flex: 1 1 100%; }
/* Your apps: a narrow column on a desk, a tab away on a phone. */
/* An admin's tick boxes are always shown (no Select toggle); 24 px to tap. */
#live-apps input[type="checkbox"] { width: 24px; height: 24px; }
@media (max-width: 899px) {
  #live-apps { display: none; }
}
/* Home's living pipeline (#8015): two lists side by side on a desk. Each list always holds three rows, so nothing below moves. */
.moving { display: grid; grid-template-columns: 1fr; gap: 12px; }
@media (min-width: 700px) {
  .moving { grid-template-columns: 1fr 1fr; }
}
.moving .row { min-height: 44px; }
.tell-box > input[name="text"] { flex: 1 1 14rem; min-width: 0; }
@media (max-width: 600px) {
  .feed .bar .btn { padding: 8px 10px; }
  .feed .disclosure > summary { min-height: 44px; display: flex; align-items: center; }
}
@media (forced-colors: active) {
  .feed > .card:focus-visible { outline: 2px solid Highlight; }
}
`;
