/**
 * The forge button as a feedback door (#4758): anyone on an app's page tells
 * the builders what they want, with no account, and sees it move. Answered
 * on the app's own host under `/__forge/note*`, never waking the app. What a
 * note does is `actions/app_notes.ts`; this is the HTTP of it.
 *
 * - `POST /__forge/note` files the note; `GET /__forge/notes` is the
 *   sender's own, with a live status. Moderation is not here: the app's own
 *   code could call it with a visiting admin's cookie, so it happens on the
 *   forge's origin (`moderateNote`), and `/__forge/note/moderate` is a 404.
 * - Same origin only, a body read only up to `REQUEST_MAX` bytes, and limits
 *   keyed on the socket's client (`http/peer.ts`), never on a header the
 *   client wrote.
 */
import { randomBytes } from "node:crypto";
import type { App } from "../app.ts";
import { notesFor, sendNote, type Sender } from "../actions/app_notes.ts";
import type { AppRecord } from "../core/apps.ts";
import { canAdmin, canRead, getRepoById, type Repo } from "../core/repos.ts";
import { getUserById, isActive, type User } from "../core/users.ts";
import { sha256 } from "../kernel/hash.ts";

export const REQUEST_MAX = 16 * 1024;
export const VISITOR_COOKIE = "forge_visitor";

export interface FeedbackAsk {
  readonly app: App;
  readonly forgeUrl: string;
  readonly request: Request;
  readonly url: URL;
  readonly record: AppRecord;
  readonly env: string;
  /** Whether this env is a sealed pull's preview: only granted people may use the door. */
  readonly sealed: boolean;
  /** The person the app's grant names, if any. */
  readonly viewerId: string | undefined;
  readonly secure: boolean;
  /** The client's limit key, from the socket (`clientBucket`). */
  readonly source: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** Same origin only: the Origin header names this very host. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

interface Door {
  readonly repo: Repo;
  readonly viewer: User | undefined;
}

/**
 * A person who reads the repository, or, on a public app on a public
 * repository, anyone: except on a sealed preview, which admits only people.
 */
function doorFor(ask: FeedbackAsk): Door | undefined {
  const repo = getRepoById(ask.app.db, ask.record.repoId);
  if (repo === undefined) return undefined;
  const raw = ask.viewerId === undefined ? undefined : getUserById(ask.app.db, ask.viewerId);
  const viewer = raw !== undefined && isActive(raw) ? raw : undefined;
  if (viewer !== undefined && canRead(ask.app.db, repo, viewer)) return { repo, viewer };
  if (!ask.sealed && ask.record.access === "public" && canRead(ask.app.db, repo, undefined)) return { repo, viewer: undefined };
  return undefined;
}

/** The sender: a person's key and name, or the anonymous cookie's. */
function senderOf(ask: FeedbackAsk, door: Door): { sender: Sender; fresh?: string } {
  if (door.viewer !== undefined)
    return { sender: { key: `u:${door.viewer.id}`, name: `@${door.viewer.username}`, person: true } };
  const have = cookieOf(ask.request, VISITOR_COOKIE);
  const cookie = have !== undefined && /^[0-9a-f]{32}$/.test(have) ? have : undefined;
  const value = cookie ?? randomBytes(16).toString("hex");
  return {
    sender: { key: `v:${value}`, name: `visitor-${sha256(value).slice(0, 6)}`, person: false },
    ...(cookie === undefined ? { fresh: value } : {}),
  };
}

const visitorCookie = (value: string, secure: boolean): string =>
  `${VISITOR_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;

/** The body as JSON, read no further than `REQUEST_MAX` bytes whatever it declares. */
async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REQUEST_MAX) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function send(ask: FeedbackAsk, door: Door): Promise<Response> {
  const { request } = ask;
  const body = await readJson(request);
  if (body === undefined) return json(400, { error: "bad_request", message: "That did not go through. Try again." });
  const { sender, fresh } = senderOf(ask, door);
  const cookies = fresh === undefined ? {} : { "set-cookie": visitorCookie(fresh, ask.secure) };
  let page = "";
  if (typeof body.page === "string") {
    try {
      const p = new URL(body.page);
      if (p.host === request.headers.get("host")) page = `${new URL(request.url).origin}${p.pathname}`.slice(0, 500);
    } catch { /* not a page of this app */ }
  }
  const viewport = typeof body.viewport === "string" && /^\d{2,5}x\d{2,5}$/.test(body.viewport) ? body.viewport : "unknown";
  const sent = await sendNote(
    ask.app, ask.record, door.repo, ask.env, ask.forgeUrl, sender,
    { text: typeof body.text === "string" ? body.text : "", page, viewport },
    ask.source,
  );
  if (!sent.ok) {
    const r = sent.error;
    const status = { empty: 400, too_long: 400, banned: 403, filtered: 422, rate_limited: 429, unavailable: 503 }[r.error];
    return json(status, { error: r.error, message: r.message }, {
      ...cookies,
      ...(r.retryAfter === undefined ? {} : { "retry-after": String(r.retryAfter) }),
    });
  }
  return json(201, { note: sent.value, name: sender.name }, cookies);
}

function list(ask: FeedbackAsk, door: Door): Response {
  const { sender, fresh } = senderOf(ask, door);
  const notes = notesFor(ask.app, ask.record, door.repo, ask.forgeUrl, sender);
  return json(
    200,
    { name: sender.name, notes, admin: door.viewer !== undefined && canAdmin(ask.app.db, door.repo, door.viewer) },
    fresh === undefined ? {} : { "set-cookie": visitorCookie(fresh, ask.secure) },
  );
}

/** Answer a `/__forge/note*` request; `undefined` when the path is not one. */
export async function feedback(ask: FeedbackAsk): Promise<Response | undefined> {
  const path = ask.url.pathname;
  const method = ask.request.method;
  if (path === "/__forge/note/moderate") return json(404, { error: "not_found" });
  if (path !== "/__forge/note" && path !== "/__forge/notes") return undefined;
  const door = doorFor(ask);
  if (door === undefined) return json(404, { error: "not_found" });
  if (path === "/__forge/notes") {
    if (method !== "GET") return json(405, { error: "method" }, { allow: "GET" });
    return list(ask, door);
  }
  if (method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
  if (!sameOrigin(ask.request)) return json(403, { error: "cross_origin" });
  return send(ask, door);
}
