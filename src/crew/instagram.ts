/**
 * Instagram, as the prompt routine sees it: who the token belongs to, the
 * newest Reel, its top-level comments, and a fresh token. The Instagram API
 * with Instagram Login (Meta's "Business Login for Instagram"): a
 * professional account, a long-lived user token, no Facebook Page.
 *
 * The interface is what the routine is written against; `graphInstagram`
 * is the one that talks to Meta, and a test hands the routine a fake. The
 * token travels only in the query string of a request to Meta's host, as
 * the API asks, and is never logged or put in a sentence.
 */

import { redactSecrets } from "../kernel/log.ts";

/** A Reel, or the newest video when the API does not say which are Reels. */
export interface Reel {
  readonly id: string;
  readonly permalink: string;
  /** As Instagram gives it, ISO 8601. */
  readonly timestamp: string;
  readonly caption: string;
  readonly commentsCount: number;
}

/** A top-level comment. */
export interface Comment {
  readonly id: string;
  readonly text: string;
  readonly username: string;
  readonly timestamp: string;
  readonly likeCount: number;
}

export interface InstagramClient {
  me(token: string): Promise<{ id: string; username: string }>;
  latestReel(token: string): Promise<Reel | undefined>;
  comments(token: string, mediaId: string): Promise<Comment[]>;
  refresh(token: string): Promise<{ token: string }>;
}

/**
 * What Meta answered with instead of data. `code` is Meta's: 190 is a
 * token that is invalid or has expired, the one a person must act on.
 */
export class InstagramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly type = "",
  ) {
    super(message);
    this.name = "InstagramError";
  }
}

/** The token is no good: the person who pasted it must make another. */
export const TOKEN_REFUSED = 190;

/**
 * One sentence for a run that met an error, for the source's `last_said`.
 * Never the token, never a stack.
 */
export function instagramSaid(error: unknown): string {
  if (error instanceof InstagramError) {
    if (error.code === TOKEN_REFUSED)
      return "Instagram no longer accepts the token; connect the account again.";
    return `Instagram answered: ${oneSentence(redactSecrets(error.message))}`;
  }
  if (error instanceof Error && error.name === "TimeoutError")
    return "Instagram did not answer within ten seconds.";
  return `The run failed: ${oneSentence(redactSecrets(error instanceof Error ? error.message : String(error)))}`;
}

function oneSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const cut = line.length > 200 ? `${line.slice(0, 199).trimEnd()}…` : line;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/**
 * The comment that becomes the tell: the most liked, and of those the
 * earliest. A comment with nothing in it is nobody's prompt.
 */
export function topComment(comments: readonly Comment[]): Comment | undefined {
  let top: Comment | undefined;
  for (const comment of comments) {
    if (comment.text.trim() === "") continue;
    if (
      top === undefined ||
      comment.likeCount > top.likeCount ||
      (comment.likeCount === top.likeCount && comment.timestamp < top.timestamp)
    )
      top = comment;
  }
  return top;
}

// ---- the real one ----

const HOST = "https://graph.instagram.com";
const VERSION = "v25.0";
const TIMEOUT_MS = 10_000;
/** How many pages of comments are read before the top is taken as found. */
export const COMMENT_PAGES = 4;
const COMMENTS_PER_PAGE = 50;
const MEDIA_PER_PAGE = 50;

type Json = Record<string, unknown>;

interface MediaItem {
  id?: unknown;
  media_type?: unknown;
  media_product_type?: unknown;
  permalink?: unknown;
  timestamp?: unknown;
  caption?: unknown;
  comments_count?: unknown;
}

interface CommentItem {
  id?: unknown;
  text?: unknown;
  username?: unknown;
  timestamp?: unknown;
  like_count?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function graphInstagram(fetchFn: typeof fetch = fetch): InstagramClient {
  const get = async (
    path: string,
    params: Record<string, string>,
  ): Promise<Json> => {
    const url = new URL(path, HOST);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as Json;
    const failure = body["error"];
    if (typeof failure === "object" && failure !== null) {
      const e = failure as Json;
      throw new InstagramError(
        num(e["code"]),
        str(e["message"]) || `Instagram answered ${response.status}`,
        str(e["type"]),
      );
    }
    if (!response.ok)
      throw new InstagramError(
        response.status,
        `Instagram answered ${response.status}`,
      );
    return body;
  };

  const items = <T>(body: Json): T[] =>
    Array.isArray(body["data"]) ? (body["data"] as T[]) : [];
  const after = (body: Json): string | undefined => {
    const paging = body["paging"];
    if (typeof paging !== "object" || paging === null) return undefined;
    const cursors = (paging as Json)["cursors"];
    if (typeof cursors !== "object" || cursors === null) return undefined;
    const cursor = str((cursors as Json)["after"]);
    return cursor === "" ? undefined : cursor;
  };

  return {
    async me(token) {
      const body = await get(`/${VERSION}/me`, {
        fields: "id,username",
        access_token: token,
      });
      return { id: str(body["id"]), username: str(body["username"]) };
    },

    async latestReel(token) {
      const body = await get(`/${VERSION}/me/media`, {
        fields:
          "id,media_type,media_product_type,permalink,timestamp,caption,comments_count",
        limit: String(MEDIA_PER_PAGE),
        access_token: token,
      });
      const media = items<MediaItem>(body);
      // Newest first. Where the API says which items are Reels, that is
      // the answer; where it does not (Instagram Login may leave the field
      // out), the newest video stands in.
      const says = media.some((m) => typeof m.media_product_type === "string");
      const found = says
        ? media.find((m) => m.media_product_type === "REELS")
        : media.find((m) => m.media_type === "VIDEO");
      if (found === undefined || str(found.id) === "") return undefined;
      return {
        id: str(found.id),
        permalink: str(found.permalink),
        timestamp: str(found.timestamp),
        caption: str(found.caption),
        commentsCount: num(found.comments_count),
      };
    },

    async comments(token, mediaId) {
      const out: Comment[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < COMMENT_PAGES; page++) {
        const body = await get(
          `/${VERSION}/${encodeURIComponent(mediaId)}/comments`,
          {
            fields: "id,text,username,timestamp,like_count",
            limit: String(COMMENTS_PER_PAGE),
            access_token: token,
            ...(cursor === undefined ? {} : { after: cursor }),
          },
        );
        for (const c of items<CommentItem>(body))
          out.push({
            id: str(c.id),
            text: str(c.text),
            username: str(c.username),
            timestamp: str(c.timestamp),
            likeCount: num(c.like_count),
          });
        cursor = after(body);
        if (cursor === undefined) break;
      }
      return out;
    },

    async refresh(token) {
      const body = await get("/refresh_access_token", {
        grant_type: "ig_refresh_token",
        access_token: token,
      });
      const fresh = str(body["access_token"]);
      if (fresh === "")
        throw new InstagramError(0, "the refresh answered with no token");
      return { token: fresh };
    },
  };
}
