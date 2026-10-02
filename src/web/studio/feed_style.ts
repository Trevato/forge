/** The feed cards' slice of the served stylesheet (no imports: `style.ts` reads this). */

export const feedCss = /* css */ `
.feed { display: grid; gap: 10px; }
.fcard { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card, var(--bg)); }
.fcard:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.fcard[hidden] { display: none; }
.fcard-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fcard-reason { margin: 8px 0 4px; font-size: 1.05em; overflow-wrap: anywhere; }
.fcard-say summary { cursor: pointer; color: var(--muted-fg, inherit); padding: 4px 0; }
.fcard-form { display: grid; gap: 8px; margin-top: 6px; }
.fcard-form textarea { width: 100%; min-height: 56px; resize: vertical; }
@media (max-width: 600px) {
  .fcard { padding: 12px; }
  .fcard-head .btn { padding: 8px 10px; }
  .fcard-say summary { padding: 10px 0; }
}
`;
