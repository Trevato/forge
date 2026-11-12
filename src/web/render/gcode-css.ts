/** The G-code layer view's styles, apart from `gcode.ts` so `style.ts` imports no renderer. */

/** The nav row wraps at 360px: the form takes its own line, Previous and Next share the one under it. */
export const gcodeCss = /* css */ `
@layer content {
.gcode-view { margin: 0; }
.gcode-nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; }
.gcode-nav > .btn { min-height: 44px; }
.gcode-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; order: -1; flex: 1 1 100%; }
.gcode-form input { width: 6em; min-height: 44px; }
.gcode-form .btn { min-height: 44px; }
.gcode-view svg { display: block; width: 100%; height: auto; max-height: 70dvh; color: var(--fg); }
@media (min-width: 640px) {
  .gcode-form { order: 0; flex: 0 1 auto; }
}
}
`;
