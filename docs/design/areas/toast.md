# Toast

The flash a write leaves after its redirect, and the same one-line banner a page shows for a failure it found itself: one `.toast` per page, toned by `data-tone=success|danger|attn` (§5's toast / flash row), an icon, then the message.

- `.toast-body` — the message beside the toast's icon: it takes the rest of the row (`flex: 1; min-width: 0`) so a long message wraps instead of pushing the icon off. Written by `flashToast` in `src/web/layout.ts` (the cookie-driven flash), and by `src/web/pages/repo.ts` (a fetch error), `src/web/pages/browse.ts` (a failed mirror) and `src/web/pages/origins.ts` (origin connected or failed); styled in `src/web/style/components.ts` under `/* ---- toast / flash ---- */`.
