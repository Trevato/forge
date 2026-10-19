/** The feed cards' slice of the served stylesheet (no imports: `style.ts` reads this). */

export const feedCss = /* css */ `
/* A timeline of rows, divided, not a stack of boxes. */
.feed { display: grid; gap: 0; border-top: 1px solid var(--border); }
.fcard { border-bottom: 1px solid var(--border); padding: 12px 4px; }
.fcard:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.fcard[hidden] { display: none; }
.fcard-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fcard-reason { margin: 8px 0 4px; font-size: 1.05em; overflow-wrap: anywhere; }
.fcard-text { white-space: pre-wrap; }
/* The planner's reply sits under the thought, indented, one or two lines. */
.fcard-reply { margin: 4px 0 0 12px; padding-left: 10px; border-left: 2px solid var(--border); overflow-wrap: anywhere; }
.fcard-unblock { display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; margin: 0; }
.fcard-unblock span { flex: 1 1 16ch; min-width: 0; overflow-wrap: anywhere; }
.fcard-who { font-weight: 600; }
/* One quiet control under the post: say something, dismiss, mute. */
.fcard-more summary { cursor: pointer; list-style: none; padding: 2px 0; }
.fcard-more summary::-webkit-details-marker { display: none; }
.fcard-acts { display: flex; gap: 4px; margin-top: 6px; }
.fcard-why { margin: 0 0 4px; }
/* The composer: the home's one primary action, on top of the timeline. */
.composer { display: grid; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card, var(--bg)); }
.composer textarea { width: 100%; min-height: 64px; resize: vertical; }
.composer-bar { display: flex; align-items: center; gap: 8px; min-width: 0; }
.composer-bar select { min-width: 0; max-width: 60%; }
/* The figures row: three cards at a fixed height, so first paint is final. */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 12px; }
.kpi { display: grid; grid-template-rows: 20px 32px 20px 24px; align-content: start; gap: 2px; padding: 12px 14px; color: inherit; text-decoration: none; }
.kpi:hover { border-color: var(--border-strong); }
.kpi-value { font-size: 16px; line-height: 32px; font-weight: 600; }
.kpi-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpi-spark { display: block; color: var(--muted-fg); max-width: 100%; }
/* Your apps: a narrow column on a desk, a tab away on a phone. */
.home-tabs { display: none; margin-bottom: 12px; }
.home-app { gap: 8px; }
.home-pick { display: none; }
#apps-select:checked ~ * .home-pick { display: inline-flex; }
#apps-select:focus-visible ~ * .home-apps-verbs label { outline: 2px solid var(--accent, currentColor); }
.home-apps-verbs { flex-wrap: wrap; padding: 10px 14px; }
@media (max-width: 899px) {
  .home-tabs { display: inline-flex; }
  /* "What you asked for" is a tab on a phone: the first post comes next.
     !important, as [hidden] is: .bar sits in a later cascade layer. */
  .feed-head { display: none !important; }
  .home-rail .home-apps { display: none; }
}
.fcard-form { display: grid; gap: 8px; margin-top: 6px; }
.fcard-form textarea { width: 100%; min-height: 56px; resize: vertical; }
@media (max-width: 600px) {
  .fcard { padding: 12px 2px; }
  .fcard-acts .btn { padding: 8px 10px; }
  .fcard-more summary { padding: 10px 0; }
}
`;
