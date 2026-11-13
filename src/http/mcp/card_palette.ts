/**
 * The card's own colours per scheme, used when the host gives none that read.
 * Each text colour is at 4.5:1 or better on its background; `test/card-shell.test.ts`
 * holds them to it. The card page is a host's sandboxed frame, so it cannot use
 * the forge's design tokens; this is the one place its colours are written (a copy
 * of the forge tokens by design, kept out of src/web, where the design lint
 * bans colour literals).
 */
export const CARD_PALETTE = {
  light: { bg: "#ffffff", fg: "#1f1f1e", link: "#0b57d0" },
  dark: { bg: "#1f1f1e", fg: "#f2f2f0", link: "#8ab4f8" },
} as const;
