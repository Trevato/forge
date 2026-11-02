/**
 * What an origin's sync and disconnect say, in one place so the page in
 * Settings › Origins and the terminal's Connected origins say the same thing.
 */

export const NO_SUCH_ORIGIN = "No such origin.";

export const syncedWords = (repos: number): string =>
  `Synced ${repos} repositor${repos === 1 ? "y" : "ies"}.`;

export const disconnectedWords = (revokedUpstream: boolean): string =>
  revokedUpstream
    ? "Disconnected, and the grant was revoked upstream."
    : "Disconnected. Revoke the token on the origin too if you want it dead there.";

/** What the confirm page tells you before a disconnect. */
export const DISCONNECT_DETAIL =
  "The stored credential is destroyed here immediately, and the repositories mirroring it stop syncing — they keep their git objects, issues and comments, and go on being readable as ordinary local repositories. The grant is revoked upstream only where the forge allows it (GitHub, and only when this forge has a client secret configured); everywhere else revoke the token on the origin yourself. The message after this says which happened.";
