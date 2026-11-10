/**
 * What an origin's sync and disconnect say, in one place so the page in
 * Settings › Origins and the terminal's Origins screen say the same thing.
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

/** Why a connect did not happen, in one sentence, on the page and in the terminal. */
export function connectWords(error: string): string {
  const words: Record<string, string> = {
    unknown_host: "That does not look like a forge this can talk to.",
    private_host: "That address is inside a network, not on the internet.",
    unreachable: "That address could not be reached, or no forge answered there.",
    bad_token: "That token was refused by the origin.",
    already_connected: "That account is already connected.",
    rate_limited: "Too many connect attempts. Wait a few minutes.",
    unauthorized: "Sign in first.",
  };
  return words[error] ?? "That connection could not be made.";
}

/** What "Check again" found, in one sentence, on the page and in the terminal. */
export const CHECK_TOO_SOON = "It was checked a moment ago. Try again in a minute.";
export const CHECK_WORDS = {
  passed: "Verified. Writes through this connection are on again.",
  unguarded: "This connection has nothing to verify.",
  unchecked: "It still could not be verified, so writes stay paused. Try again in a few minutes.",
  refused: "This connection was refused. Reconnect it with an account the operator allows.",
} as const;
