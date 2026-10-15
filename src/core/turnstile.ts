/**
 * Cloudflare Turnstile: is the one signing up a person? `siteverify` takes
 * the secret and the token the widget gave the browser and answers yes or no.
 * The secret comes from the environment (`FORGE_TURNSTILE_SECRET`), never the
 * repository. Any failure to ask — network, status, a body that is not JSON —
 * is a no: a gate that fails open is not one.
 */

/** Says whether a token proves a person; `address` is the client's, when known. */
export type VerifyHuman = (token: string, address?: string) => Promise<boolean>;

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** A token is a short opaque string; Cloudflare caps it at 2048 characters. */
const MAX_TOKEN = 2048;
const ASK_TIMEOUT_MS = 5000;

export function turnstileVerifier(
  secret: string,
  ask: typeof fetch = fetch,
): VerifyHuman {
  return async (token, address) => {
    if (token === "" || token.length > MAX_TOKEN) return false;
    const body = new URLSearchParams({ secret, response: token });
    if (address !== undefined) body.set("remoteip", address);
    try {
      const response = await ask(SITEVERIFY_URL, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const answer = (await response.json()) as { success?: unknown };
      return answer.success === true;
    } catch {
      return false;
    }
  };
}
