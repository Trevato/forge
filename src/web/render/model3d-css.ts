/** The 3D frame's styles, apart from `model3d.ts` so `style.ts` imports no renderer. */

/** The frame holds its height before the viewer arrives: no layout shift. */
export const model3dCss = /* css */ `
@layer content {
.model3d { margin: 0; }
.model3d-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.model3d-head .row-facts { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; }
.model3d-tools { display: inline-flex; gap: 6px; }
.model3d-stage { position: relative; aspect-ratio: 4 / 3; max-height: 70dvh; width: 100%; display: grid; place-items: center; touch-action: none; }
.model3d-stage > canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
}
`;
