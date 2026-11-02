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
 * - `POST /__forge/note/picture?note=<id>` adds the picture a sender chose to
 *   send (#4820) to a note of theirs: raw PNG or JPEG bytes, at most
 *   `PICTURE_MAX`, judged by their signature, one per note.
 * - Same origin only, a body read only up to `REQUEST_MAX` bytes, and limits
 *   keyed on the socket's client (`http/peer.ts`), never on a header the
 *   client wrote.
 */
import { randomBytes } from "node:crypto";
import type { App } from "../app.ts";
import { notesFor, sendNote, type Sender } from "../actions/app_notes.ts";
import type { AppRecord } from "../core/apps.ts";
import { canAdmin, canRead, getRepoById, type Repo } from "../core/repos.ts";
import { getNote } from "../core/app_notes.ts";
import { PICTURE_MAX, savePicture, sniffPicture } from "../core/note_pictures.ts";
import { getUserById, isActive, type User } from "../core/users.ts";
import { sha256 } from "../kernel/hash.ts";
import { NOTE_FAILED } from "./note_words.ts";

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
  /** The grant cookie's value, which the panel's proof is bound to. */
  readonly grantCookie?: string | undefined;
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

// ---- the panel's one-use proof ----
//
// The app's own code runs on this origin and can send the person's grant
// cookie with a fetch, so a cookie alone does not say the forge panel asked.
// The panel's script tag carries a token the forge minted for that page load;
// each answer to a request that spent one carries the next in `x-forge-proof`.
// Held in memory, as the process is one: a restart makes everyone a visitor
// until the next page load.

export const PROOF_HEADER = "x-forge-proof";
const PROOF_TTL_MS = 24 * 3_600_000;
const PROOF_MAX = 20_000;
const proofs = new Map<string, { bind: string; expires: number }>();

const bindOf = (grantCookie: string, host: string): string => sha256(`${host}\n${grantCookie}`);

/** A fresh token for this grant cookie on this host. Never put it in a URL. */
export function mintProof(grantCookie: string, host: string, now = Date.now()): string {
  while (proofs.size >= PROOF_MAX) proofs.delete(proofs.keys().next().value!);
  const token = randomBytes(24).toString("base64url");
  proofs.set(token, { bind: bindOf(grantCookie, host), expires: now + PROOF_TTL_MS });
  return token;
}

/** Spend a token: true once, for the grant and host it was minted for. */
function spendProof(token: string | null, grantCookie: string | undefined, host: string | null, now = Date.now()): boolean {
  if (token === null || grantCookie === undefined || host === null) return false;
  const held = proofs.get(token);
  if (held === undefined) return false;
  proofs.delete(token);
  return held.expires > now && held.bind === bindOf(grantCookie, host);
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
  if (body === undefined) return json(400, { error: "bad_request", message: NOTE_FAILED });
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

/** The body's bytes, read no further than `PICTURE_MAX`; `undefined` when it is longer. */
async function readPicture(request: Request): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > PICTURE_MAX || request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PICTURE_MAX) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function picture(ask: FeedbackAsk, door: Door): Promise<Response> {
  const { sender } = senderOf(ask, door);
  const asked = ask.url.searchParams.get("note") ?? "";
  const note = /^[0-9a-z]{10,40}$/.test(asked) ? getNote(ask.app.db, ask.record.id, asked) : undefined;
  // Only the sender's own note takes a picture.
  if (note === undefined || note.visitor !== sender.key || note.hidden) return json(404, { error: "not_found" });
  const bytes = await readPicture(ask.request);
  if (bytes === undefined) return json(413, { error: "too_large", message: "That picture is too big. It must be under 2 MB." });
  const kind = sniffPicture(bytes);
  if (kind === undefined) return json(415, { error: "not_a_picture", message: "Only a PNG or JPEG picture can be sent." });
  if (!savePicture(ask.app.db, ask.app.config.dataDir, note, kind, bytes))
    return json(409, { error: "has_picture", message: "That note already has a picture." });
  return json(201, { ok: true });
}

function list(ask: FeedbackAsk, door: Door, proven: boolean): Response {
  const { sender, fresh } = senderOf(ask, door);
  const notes = notesFor(ask.app, ask.record, door.repo, ask.forgeUrl, sender);
  return json(
    200,
    { name: sender.name, notes, admin: proven && door.viewer !== undefined && canAdmin(ask.app.db, door.repo, door.viewer) },
    fresh === undefined ? {} : { "set-cookie": visitorCookie(fresh, ask.secure) },
  );
}

/** Answer a `/__forge/note*` request; `undefined` when the path is not one. */
export async function feedback(ask: FeedbackAsk): Promise<Response | undefined> {
  const path = ask.url.pathname;
  const method = ask.request.method;
  if (path === "/__forge/note/moderate") return json(404, { error: "not_found" });
  if (path !== "/__forge/note" && path !== "/__forge/notes" && path !== "/__forge/note/picture") return undefined;
  const host = ask.request.headers.get("host");
  const proven = spendProof(ask.request.headers.get(PROOF_HEADER), ask.grantCookie, host);
  const answer = await answerNote(proven ? ask : { ...ask, viewerId: undefined }, path, method, proven);
  if (proven) answer.headers.set(PROOF_HEADER, mintProof(ask.grantCookie!, host!));
  return answer;
}

async function answerNote(ask: FeedbackAsk, path: string, method: string, proven: boolean): Promise<Response> {
  const door = doorFor(ask);
  if (door === undefined) return json(404, { error: "not_found" });
  if (path === "/__forge/notes") {
    if (method !== "GET") return json(405, { error: "method" }, { allow: "GET" });
    return list(ask, door, proven);
  }
  if (method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
  if (!sameOrigin(ask.request)) return json(403, { error: "cross_origin" });
  return path === "/__forge/note/picture" ? picture(ask, door) : send(ask, door);
}
