/**
 * The phone share sheet's contract, in one place: the web manifest's
 * `share_target` (standards.ts) and the composer that receives it
 * (studio/feed.ts, studio/actions.ts) both import these names, so they
 * cannot drift apart.
 *
 * A share arrives as `GET /?title=…&text=…&url=…`; the composer opens with
 * those words as a draft; Post is `POST /tell` with the fields below.
 */
import type { URLSearchParams as Params } from "node:url";

/** The query parameters a share carries, in the order they are joined. */
export const SHARE_PARAMS = { title: "title", text: "text", url: "url" } as const;

/** What the manifest declares. */
export const SHARE_TARGET = { action: "/", method: "GET", params: SHARE_PARAMS } as const;

/** The composer form's field names. */
export const COMPOSER_FIELDS = { text: "text", app: "app", back: "back", once: "once" } as const;

/** The longest tell the composer takes (its textarea's `maxlength`). */
export const TELL_MAX = 2000;

/** Title, text and link joined into one draft; nothing is said twice. Never sent until Post. */
export function sharedDraft(params: URLSearchParams | Params): string {
  const parts: string[] = [];
  for (const key of Object.values(SHARE_PARAMS)) {
    const part = (params.get(key) ?? "").trim();
    if (part !== "" && !parts.some((p) => p.includes(part))) parts.push(part);
  }
  return parts.join("\n").slice(0, TELL_MAX);
}

/** A token naming one shared draft for one person: sending it twice tells once. */
export function shareToken(userId: string, draft: string): string {
  return new Bun.CryptoHasher("sha256").update(`${userId}\n${draft}`).digest("hex").slice(0, 24);
}

const SENT = new Map<string, number>();
const SENT_FOR_MS = 10 * 60 * 1000;
const SENT_KEEP = 2000;
const TOKEN = /^[0-9a-f]{24}$/;

/**
 * "fresh" the first time a person claims a token within ten minutes (it is now
 * held), "seen" after, "bad" when the token is not one we issued. A share sent
 * with no token at all is not asked about here: the caller does not call.
 */
export function claimShare(userId: string, token: string, now = Date.now()): "fresh" | "seen" | "bad" {
  if (!TOKEN.test(token)) return "bad";
  const key = `${userId}:${token}`;
  const at = SENT.get(key);
  if (at !== undefined && now - at < SENT_FOR_MS) return "seen";
  SENT.delete(key);
  // Oldest first: a Map iterates in insertion order.
  for (const [k] of SENT) {
    if (SENT.size < SENT_KEEP) break;
    SENT.delete(k);
  }
  SENT.set(key, now);
  return "fresh";
}

/** Give a token back: the tell it guarded was not made, so the retry must go through. */
export function releaseShare(userId: string, token: string): void {
  SENT.delete(`${userId}:${token}`);
}

/** Forget what was sent (tests). */
export function forgetShares(): void {
  SENT.clear();
}
