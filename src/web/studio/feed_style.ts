/** The feed cards' slice of the served stylesheet (no imports: `style.ts` reads this). */

export const feedCss = /* css */ `
.feed { display: grid; gap: 10px; }
.fcard { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card, var(--bg)); }
.fcard:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.fcard[hidden] { display: none; }
.fcard-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fcard-reason { margin: 8px 0 4px; font-size: 1.05em; overflow-wrap: anywhere; }
.fcard-who { font-weight: 600; }
.fcard-why { margin: 0 0 4px; }
/* The composer: the home's one primary action, on top of the timeline. */
.composer { display: grid; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card, var(--bg)); }
.composer textarea { width: 100%; min-height: 64px; resize: vertical; }
.composer-bar { display: flex; align-items: center; gap: 8px; min-width: 0; }
.composer-bar select { min-width: 0; max-width: 60%; }
/* Your apps: a narrow column on a desk, a tab away on a phone. */
.home-tabs { display: none; margin-bottom: 12px; }
.home-app { gap: 8px; }
.home-apps-verbs { flex-wrap: wrap; padding: 10px 14px; }
@media (max-width: 899px) {
  .home-tabs { display: inline-flex; }
  .home-rail .home-apps { display: none; }
}
.fcard-say summary { cursor: pointer; color: var(--muted-fg, inherit); padding: 4px 0; }
.fcard-form { display: grid; gap: 8px; margin-top: 6px; }
.fcard-form textarea { width: 100%; min-height: 56px; resize: vertical; }
@media (max-width: 600px) {
  .fcard { padding: 12px; }
  .fcard-head .btn { padding: 8px 10px; }
  .fcard-say summary { padding: 10px 0; }
}
`;
