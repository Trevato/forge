/**
 * Apps on the forge's own port, by `Host`. `<slug>.<domain>` is production,
 * `<slug>--<n>.<domain>` the preview of pull `n`; the request is fetched
 * from the deployment's loopback port and streamed back. A websocket
 * handshake is the same request until the app accepts it — then the forge
 * holds one socket to the browser and one to the app and carries frames
 * between them, and nothing else.
 *
 * A private app answers only to a visitor the forge has vouched for. The
 * app's host sets no cookie of its own; the forge sends the visitor to
 * `/__forge/grant?t=…` on the app's host with a token it signed after
 * checking `canRead`, and that handler sets the grant cookie. Nothing on
 * the app host can mint one — the key never leaves the forge's data
 * directory — so guessing a hostname yields the forge's own "not found".
 */

import { appHostSuffix } from "./host.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import { getAppById, getAppBySlug, type AppRecord } from "../core/apps.ts";
import { getVerifiedDomain } from "../core/domains.ts";
import { canEnterApp, canRead, getRepoById } from "../core/repos.ts";
import { getUserById, isActive } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { loadKey } from "../kernel/secret.ts";
import { previewEnv, type EnvName } from "./data.ts";
import type { AppsRuntime, EnvStatus } from "./runtime.ts";

export interface AppTarget {
  readonly app: AppRecord;
  readonly env: EnvName;
  /**
   * The hostname named something in front of this app's label: an app of a
   * forge hosted here. Such a request is the guest's to route — including
   * its own `/__forge/grant`, which carries a token this forge did not sign.
   */
  readonly nested?: boolean;
}

/**
 * What a `Host` may look like before it is read as anything: a hostname of
 * letters, digits, dots and hyphens, and at most a port. Nothing here can
 * be reparsed into another host by a URL parser (`#`, `@`, `/`, `?`,
 * spaces), so every reading below agrees on which machine is meant.
 */
export const isHostPort = (host: string): boolean =>
  /^[a-z0-9](?:[a-z0-9.-]{0,252})?(?::\d{1,5})?$/i.test(host);

/**
 * Which app and environment a `Host` names, if any. Hostnames are
 * case-insensitive and may carry a port. Only one label may sit in front
 * of the domain: `a.b.<domain>` is not an app.
 */
export function parseAppHost(
  hostHeader: string,
  domain: string,
): { slug: string; env: EnvName; nested: boolean } | undefined {
  if (!isHostPort(hostHeader)) return undefined;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  const suffix = appHostSuffix(domain.toLowerCase().replace(/:\d+$/, ""));
  if (!host.endsWith(suffix)) return undefined;
  const label = host.slice(0, -suffix.length);
  if (label === "" || label.includes(".")) return undefined;
  const parts = label.split("--");
  if (parts.some((part) => part === "")) return undefined;
  // The app of ours is the tail of the label: `slug`, or `slug--N` for the
  // preview of pull N. Whatever comes before it belongs to the app's own
  // world — a forge hosted here has apps of its own, at `<theirs>--<ours>`
  // — and travels through untouched in `Host`, for that app to route.
  const last = parts.at(-1)!;
  if (parts.length >= 2 && /^\d+$/.test(last)) {
    if (!/^[1-9]\d*$/.test(last)) return undefined;
    return {
      slug: parts.at(-2)!,
      env: previewEnv(Number(last)),
      nested: parts.length > 2,
    };
  }
  return { slug: last, env: "production", nested: parts.length > 1 };
}

/**
 * The app a request's `Host` addresses, resolved against the database.
 * `"unknown"` is a hostname shaped like an app's that names none — it must
 * not fall through to the forge's own pages, or `nothing.<domain>` would
 * render the forge's home under a stranger's name.
 */
export function resolveAppHost(
  app: App,
  domain: string,
  request: Request,
): AppTarget | "unknown" | undefined {
  const host = request.headers.get("host");
  if (host === null) return undefined;
  return resolveAppHostname(app, domain, host);
}

/** The same, for a hostname on its own — what the forge's own pages are handed. */
export function resolveAppHostname(
  app: App,
  domain: string,
  host: string,
): AppTarget | "unknown" | undefined {
  const parsed = parseAppHost(host, domain);
  if (parsed === undefined) return ownDomain(app, host);
  const record = getAppBySlug(app.db, parsed.slug);
  return record
    ? { app: record, env: parsed.env, nested: parsed.nested }
    : "unknown";
}

/**
 * A hostname that is no label of ours may still be an app's own domain,
 * once the person who added it has proved they hold it (core/domains.ts).
 * Until then, and for every other name, the forge answers for itself —
 * its own pages, at whatever name it is reached by — so a domain added
 * but not yet verified serves nothing of the app.
 */
function ownDomain(app: App, host: string): AppTarget | undefined {
  const domain = getVerifiedDomain(app.db, host.replace(/:\d+$/, ""));
  if (domain === undefined) return undefined;
  const record = getAppById(app.db, domain.appId);
  return record === undefined
    ? undefined
    : { app: record, env: domain.env, nested: false };
}

/**
 * The origin a visitor is sent back to: the hostname they asked for, at
 * the port they asked for it on when the name carried one; otherwise the
 * environment's own URL decides the port. An app's canonical host carries
 * the forge's, its own domain none — and only what the browser sent says
 * which the visitor is at.
 */
export function originFor(
  runtime: AppsRuntime,
  target: AppTarget,
  host?: string,
): string {
  const base = new URL(runtime.urlFor(target.app, target.env));
  // Only a bare hostname, with or without a port, is a place to send
  // anyone. A URL parser reads `evil#x--notes.apps.test` as the host `evil`
  // while the label check above read it as ours — the same string must
  // never mean two hosts, so anything else is not a host at all.
  if (host === undefined || !isHostPort(host)) return base.origin;
  const asked = URL.parse(`${base.protocol}//${host}`);
  if (asked === null) return base.origin;
  base.hostname = asked.hostname;
  if (asked.port !== "") base.port = asked.port;
  return base.origin;
}

/**
 * The grant cookie is named for the app it admits to. Two forges can set
 * grants on one hostname — this one, and a forge it hosts, for an app of
 * that forge's own — and each must find its own cookie beside the other's.
 */
const grantCookieName = (target: AppTarget): string =>
  `forge_grant_${target.app.id.slice(-8)}`;
const GRANT_URL_TTL_MS = 2 * 60_000;
const GRANT_COOKIE_TTL_MS = 12 * 60 * 60_000;

/**
 * Who a grant vouches for. `user` can see the app's repository; `admin`
 * can write it. A grant with nobody named is a door opened for a visitor
 * the forge could not name (a public app's guest who never signed in).
 */
export interface GrantWho {
  readonly id: string;
  readonly name: string;
  readonly role: "user" | "admin";
}

/**
 * A signed grant: `<app id>.<env>.<expiry ms>.<user id>.<username>.<role>.<signature>`,
 * with `-` in the three person fields when nobody is named. Usernames and
 * ids never contain a dot, so the token splits cleanly.
 */
export function signGrant(
  dataDir: string,
  target: AppTarget,
  ttlMs: number,
  now = Date.now(),
  who?: GrantWho,
): string {
  const payload = `${target.app.id}.${target.env}.${now + ttlMs}.${who?.id ?? "-"}.${who?.name ?? "-"}.${who?.role ?? "-"}`;
  return `${payload}.${mac(dataDir, payload)}`;
}

function mac(dataDir: string, payload: string): string {
  return createHmac("sha256", loadKey(dataDir))
    .update(payload)
    .digest("base64url");
}

/** A grant taken apart and checked: who it names, and until when. */
export interface Grant {
  readonly who: GrantWho | undefined;
  readonly expiresMs: number;
}

/** The grant behind a token, when it vouches for this target right now. */
export function readGrant(
  dataDir: string,
  grant: string,
  target: AppTarget,
  now = Date.now(),
): Grant | undefined {
  const parts = grant.split(".");
  if (parts.length !== 7) return undefined;
  const [appId, env, expires, id, name, role, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (appId !== target.app.id || env !== target.env) return undefined;
  if (!/^\d+$/.test(expires) || Number(expires) <= now) return undefined;
  const expected = mac(
    dataDir,
    `${appId}.${env}.${expires}.${id}.${name}.${role}`,
  );
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const named: GrantWho | undefined =
    id !== "-" && name !== "-" && (role === "user" || role === "admin")
      ? { id, name, role }
      : undefined;
  return { who: named, expiresMs: Number(expires) };
}

/** Whether `grant` vouches for this target right now. */
export function verifyGrant(
  dataDir: string,
  grant: string,
  target: AppTarget,
  now = Date.now(),
): boolean {
  return readGrant(dataDir, grant, target, now) !== undefined;
}

/**
 * The key an app verifies identity with, derived from the forge's own so
 * nothing new is stored: the same for production and every preview of the
 * app, different for every app.
 */
export function identityKey(dataDir: string, appId: string): string {
  return createHmac("sha256", loadKey(dataDir))
    .update(`identity:${appId}`)
    .digest("hex");
}

/**
 * What the app hears about the visitor: `x-forge-identity` is
 * `<user id>|<username>|<role>|<expiry ms>` and `x-forge-signature` is its
 * HMAC-SHA256 (base64url) under the app's identity key. No headers means
 * nobody the forge could name. A client's own copies of these headers are
 * dropped before the forge speaks, so a verified signature is the only
 * thing an app has to trust.
 */
export const IDENTITY_HEADERS = ["x-forge-identity", "x-forge-signature"];

export function identityHeaders(
  dataDir: string,
  appId: string,
  grant: Grant | undefined,
): Record<string, string> {
  if (grant?.who === undefined) return {};
  const identity = `${grant.who.id}|${grant.who.name}|${grant.who.role}|${grant.expiresMs}`;
  const signature = createHmac("sha256", identityKey(dataDir, appId))
    .update(identity)
    .digest("base64url");
  return { "x-forge-identity": identity, "x-forge-signature": signature };
}

/** The URL the forge redirects a vouched-for visitor to. */
export function grantUrl(
  runtime: AppsRuntime,
  target: AppTarget,
  path = "/",
  host?: string,
  who?: GrantWho,
): string {
  const token = signGrant(
    runtime.app.config.dataDir,
    target,
    GRANT_URL_TTL_MS,
    Date.now(),
    who,
  );
  // The cookie a grant sets belongs to one hostname. A visitor who asked
  // for a hostname inside the app's own world — an app of a forge hosted
  // here, or the app's canonical host when it has a domain of its own —
  // must be granted on that hostname, not the one production's URL names,
  // or the cookie lands where the request never goes.
  return `${originFor(runtime, target, host)}/__forge/grant?t=${encodeURIComponent(token)}&to=${encodeURIComponent(path)}`;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Whether the person a grant names may enter this app now. */
function stillEntitled(
  runtime: AppsRuntime,
  target: AppTarget,
  grant: Grant,
): boolean {
  if (grant.who === undefined) return false;
  const repo = getRepoById(runtime.app.db, target.app.repoId);
  const user = getUserById(runtime.app.db, grant.who.id);
  return (
    repo !== undefined &&
    user !== undefined &&
    isActive(user) &&
    canEnterApp(runtime.app.db, repo, target.app, user)
  );
}

/**
 * What a request addressed to an app must pass before anything is served:
 * a private app's grant, then a live port. One gate for both the request
 * that is fetched and the one that becomes a socket — the answer when a
 * gate refuses is the response to send instead.
 */
function admit(
  runtime: AppsRuntime,
  request: Request,
  target: AppTarget,
): Result<{ status: EnvStatus; port: number; grant?: Grant }, Response> {
  const cookie = cookieValue(request, grantCookieName(target));
  const signed =
    cookie === undefined
      ? undefined
      : readGrant(runtime.app.config.dataDir, cookie, target);
  // A private app's grant is asked again on every request whether the
  // person it names may still enter: a grant outlives a change of heart —
  // a writer removed, the app made private — by up to twelve hours, and
  // reading the repository was never enough (#620).
  const grant =
    signed !== undefined &&
    target.app.access === "private" &&
    !stillEntitled(runtime, target, signed)
      ? undefined
      : signed;
  if (target.app.access === "private") {
    if (grant === undefined) {
      // A person arriving by link is sent to the forge to sign in; it vouches
      // for them if they may enter the app and sends them back with the
      // grant, and otherwise gives the answer a private repository gives.
      // Anything that is not a person navigating — a script, an API call —
      // gets that answer here.
      const url = new URL(request.url);
      const navigating =
        (request.method === "GET" || request.method === "HEAD") &&
        (request.headers.get("accept") ?? "").includes("text/html") &&
        !url.pathname.startsWith("/__forge/");
      if (navigating) {
        const host = request.headers.get("host") ?? "";
        const open = new URL("/apps/open", runtime.options.forgeUrl);
        open.searchParams.set("host", host);
        open.searchParams.set("to", url.pathname + url.search);
        return err(
          new Response(null, {
            status: 303,
            headers: { location: open.toString(), "cache-control": "no-store" },
          }),
        );
      }
      return err(new Response("not found", { status: 404 }));
    }
  }
  // A preview stopped for want of attention is asked for: it deploys again
  // the ordinary way, and this request sees "starting" until it answers.
  if (runtime.envStatus(target.app, target.env)?.dormant !== undefined)
    runtime.rouse(target.app, target.env);
  const status = runtime.envStatus(target.app, target.env);
  if (status === undefined || status.port === undefined) {
    return err(unavailable(runtime, target, status));
  }
  return ok(
    grant === undefined
      ? { status, port: status.port }
      : { status, port: status.port, grant },
  );
}

/**
 * Where a stranger reports a problem with this app: its repository's report
 * form (`actions/reports.ts`), when both the app and the repository are
 * public. A private one offers nothing, and a nested host is its guest's.
 */
function reportUrl(runtime: AppsRuntime, target: AppTarget): URL | undefined {
  if (target.nested || target.app.access !== "public") return undefined;
  const repo = getRepoById(runtime.app.db, target.app.repoId);
  if (repo === undefined || !canRead(runtime.app.db, repo, undefined))
    return undefined;
  return new URL(
    `/${repo.ownerName}/${repo.name}/report`,
    runtime.options.forgeUrl,
  );
}

/** The link relation a public app's pages carry to `/__forge/report`. */
const REPORT_LINK =
  '</__forge/report>; rel="help"; title="Report a problem (no account needed)"';

const isHtml = (headers: Headers): boolean =>
  (headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");

/**
 * Serve a request addressed to an app. `undefined` means the request became
 * a websocket: the response was the handshake, and `appWebSocket` now owns
 * the connection.
 */
export async function proxyApp(
  runtime: AppsRuntime,
  request: Request,
  target: AppTarget,
  server: Bun.Server<AppSocket>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  // A grant with this forge's own token is answered here. On a nested
  // hostname a grant this forge did not sign is the guest forge's, and
  // goes through to it like any other request.
  if (url.pathname === "/__forge/grant") {
    const token = url.searchParams.get("t") ?? "";
    if (
      !target.nested ||
      verifyGrant(runtime.app.config.dataDir, token, target)
    )
      return grant(runtime, request, url, target);
  }
  // The two doors an app links to: sign in sends the visitor to the forge,
  // which vouches for them and sends them back named; sign out drops the
  // grant so the app hears nobody again.
  if (url.pathname === "/__forge/signin" && !target.nested) {
    const open = new URL("/apps/open", runtime.options.forgeUrl);
    open.searchParams.set("host", request.headers.get("host") ?? "");
    open.searchParams.set("to", safePath(url.searchParams.get("to")));
    return new Response(null, {
      status: 303,
      headers: { location: open.toString(), "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/__forge/signout" && !target.nested) {
    const secure =
      url.protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https";
    return new Response(null, {
      status: 303,
      headers: {
        location: safePath(url.searchParams.get("to")),
        "set-cookie": `${grantCookieName(target)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
        "cache-control": "no-store",
      },
    });
  }
  // The third door: a problem report, answered without waking or even
  // reaching the app — the app being down is the usual reason to ask. The
  // forge's form is told which page it came from.
  if (url.pathname === "/__forge/report") {
    const report = reportUrl(runtime, target);
    if (report !== undefined) {
      report.searchParams.set(
        "from",
        originFor(runtime, target, request.headers.get("host") ?? undefined) +
          safePath(url.searchParams.get("from")),
      );
      return new Response(null, {
        status: 303,
        headers: { location: report.toString(), "cache-control": "no-store" },
      });
    }
  }
  // An environment asleep wakes for the request that wants it, and the
  // request waits the second that takes rather than seeing a closed door.
  if (runtime.envStatus(target.app, target.env)?.state === "asleep")
    await runtime.wake(target.app, target.env);
  const admitted = admit(runtime, request, target);
  if (!admitted.ok) return admitted.error;
  const { status, port, grant: vouched } = admitted.value;
  runtime.touch(target.app, target.env);

  const upstream = new URL(url);
  upstream.protocol = "http:";
  upstream.hostname = "127.0.0.1";
  upstream.port = String(port);
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  headers.set("x-forwarded-host", request.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  for (const [name, value] of Object.entries(
    identityHeaders(runtime.app.config.dataDir, target.app.id, vouched),
  ))
    headers.set(name, value);

  if (isWebSocketHandshake(request)) {
    return proxyWebSocket(
      runtime,
      server,
      request,
      target,
      status,
      upstream,
      headers,
    );
  }

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? null
          : request.body,
      redirect: "manual",
      signal: request.signal,
      // Bytes through, untouched: the app chose its encoding.
      decompress: false,
    } as RequestInit);
  } catch {
    return unavailable(runtime, target, status, "the app stopped answering");
  }
  const out = new Headers(response.headers);
  for (const name of HOP_BY_HOP) out.delete(name);
  // An agent reading a public app's page learns where to report a problem
  // without the app having to say so.
  if (isHtml(out) && reportUrl(runtime, target) !== undefined)
    out.append("link", REPORT_LINK);
  const eventStream =
    response.body !== null &&
    (response.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("text/event-stream");
  return new Response(
    eventStream ? held(runtime, target, response.body!) : response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    },
  );
}

/**
 * An event stream, passed through untouched while it keeps the environment
 * busy: held from its first byte until it ends, fails, or the browser
 * goes away.
 */
export function held(
  runtime: AppsRuntime,
  target: AppTarget,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const release = runtime.holdStream(target.app, target.env);
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch {
        // The app went away under it — replaced by a deploy, asleep,
        // stopped. For an event stream that is its end, not an error to
        // raise into a connection nobody may be reading: the browser's
        // EventSource reconnects to whatever serves now.
        release();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

// ---- websockets ----

/**
 * The forge's end of a proxied websocket: the app's side of it, and
 * nothing else. Everything the connection knows lives here, on the socket,
 * so a forge with a thousand of them has no table to keep in step.
 */
export interface AppSocket {
  readonly upstream: WebSocket;
}

/**
 * The most one frame may carry, in either direction. The browser's side is
 * enforced by Bun before a frame reaches us; the app's side is checked
 * here, because the client Bun gives us has no ceiling of its own. It is
 * also how much may queue for a browser that has stopped reading — past
 * it the socket is closed rather than the memory kept, and the forge never
 * buffers a frame on its own account.
 */
const WS_MAX_MESSAGE = 16 * 1024 * 1024;
/**
 * Seconds a socket may go without a frame or a pong before it is dropped.
 * Bun pings on its own at half this, so a quiet tab that is still there
 * stays connected; only a peer that has stopped answering is let go.
 */
const WS_IDLE_SECONDS = 120;

/**
 * A handshake is a GET that asks to upgrade and carries a key. A request
 * that merely says `Upgrade: websocket` is an ordinary request, and is
 * fetched as one with the hop-by-hop headers stripped, as it always was.
 */
const isWebSocketHandshake = (request: Request): boolean =>
  request.method === "GET" &&
  request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
  request.headers.has("sec-websocket-key");

/** The subprotocols a handshake offers, in the order it offers them. */
const offeredProtocols = (request: Request): string[] =>
  (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * Open the app's side first, and only then answer the browser: a handshake
 * the app does not accept is an HTTP failure, with the forge's own page,
 * never a socket that opens and shuts.
 */
async function proxyWebSocket(
  runtime: AppsRuntime,
  server: Bun.Server<AppSocket>,
  request: Request,
  target: AppTarget,
  status: EnvStatus,
  upstreamUrl: URL,
  forwarded: Headers,
): Promise<Response | undefined> {
  const url = new URL(upstreamUrl);
  url.protocol = "ws:";
  const headers: Record<string, string> = {};
  forwarded.forEach((value, name) => {
    // The client writes its own handshake; the browser's key, version and
    // extensions belong to the hop that is ending here.
    if (!name.startsWith("sec-websocket-")) headers[name] = value;
  });
  const opened = await connectUpstream(url, headers, offeredProtocols(request));
  if (!opened.ok) {
    return unavailable(runtime, target, status, opened.error);
  }
  const upstream = opened.value;
  // Open, the socket keeps the environment busy; its close — from either
  // side, or a failed upgrade below — lets it rest again.
  upstream.addEventListener(
    "close",
    runtime.holdStream(target.app, target.env),
  );
  const upgraded = server.upgrade(request, {
    data: { upstream },
    // The app's choice of subprotocol is what the browser hears; without
    // one Bun echoes the first the browser offered, which is what the app
    // itself would have done on Bun.
    ...(upstream.protocol === ""
      ? {}
      : { headers: { "sec-websocket-protocol": upstream.protocol } }),
  });
  if (upgraded) return undefined;
  upstream.close(1000);
  return new Response("bad websocket handshake", { status: 400 });
}

/**
 * A client socket to the app, resolved once it is open. A refusal is a
 * sentence for the "not running" page: the app was not listening, or it
 * answered the handshake with something other than a socket.
 */
function connectUpstream(
  url: URL,
  headers: Record<string, string>,
  protocols: string[],
): Promise<Result<WebSocket, string>> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers, protocols });
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => resolve(ok(socket)), { once: true });
    socket.addEventListener(
      "close",
      (event) =>
        resolve(
          err(
            // 1002 is Bun's word for a handshake the app answered with a
            // status other than 101 — a path it does not upgrade.
            event.code === 1002
              ? "the app did not accept a websocket at this path"
              : "the app stopped answering",
          ),
        ),
      { once: true },
    );
    // The close that follows carries the verdict; an error on its own has
    // nothing to add and must not go unhandled.
    socket.addEventListener("error", () => {});
  });
}

/**
 * Whether a close code survives the trip. 1005 (none given), 1006 (lost)
 * and 1015 (TLS) are only ever reported, never sent, and Bun's client
 * turns 1012–1014 and 3000–3999 into a dropped connection rather than a
 * frame. What is left is carried as it is; the rest becomes 1000 with the
 * reason kept — though toward the app that same client (Bun 1.3) delivers
 * a reason of one byte and drops a longer one. The code always arrives.
 */
const sendable = (code: number): boolean =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1011) ||
  (code >= 4000 && code <= 4999);

/** Close both ends with one verdict. */
function closeBoth(
  ws: Bun.ServerWebSocket<AppSocket>,
  code: number,
  reason: string,
): void {
  ws.close(code, reason);
  ws.data.upstream.close(code, reason);
}

/**
 * The forge's `websocket` handler: frames through, both ways, and the
 * close of one side carried to the other. Text stays text and binary
 * stays binary; the forge reads neither.
 */
export const appWebSocket: Bun.WebSocketHandler<AppSocket> = {
  maxPayloadLength: WS_MAX_MESSAGE,
  backpressureLimit: WS_MAX_MESSAGE,
  closeOnBackpressureLimit: true,
  idleTimeout: WS_IDLE_SECONDS,

  open(ws) {
    const { upstream } = ws.data;
    // No frame from the app can get here first. Its `open` event resolved
    // `connectUpstream`, and the microtask checkpoint after that callback
    // runs `proxyWebSocket` to completion — `server.upgrade` calls this
    // handler synchronously — before the loop dispatches the next event,
    // so a greeting the app sent the moment its socket opened, even one
    // corked into the same write as its 101, still finds this listener.
    // test/apps-ws.test.ts holds the app to exactly that.
    upstream.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      const size =
        typeof data === "string"
          ? Buffer.byteLength(data)
          : (data as ArrayBuffer).byteLength;
      if (size > WS_MAX_MESSAGE) {
        closeBoth(ws, 1009, "message too big");
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const sent =
        typeof data === "string" ? ws.send(data) : ws.send(data as ArrayBuffer);
      // 0 is a frame Bun dropped, because more than the limit was already
      // waiting on a browser that is not reading. A stream with a hole in
      // it is not a stream; end it rather than let the app keep talking.
      if (sent === 0 && ws.readyState === WebSocket.OPEN) {
        closeBoth(ws, 1008, "not reading");
      }
    });
    upstream.addEventListener("close", (event: CloseEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // The app went away without a word: a crash, a redeploy, a stop.
      if (event.code === 1006) ws.close(1001, "the app stopped answering");
      else ws.close(sendable(event.code) ? event.code : 1000, event.reason);
    });
    // Opened a moment ago, and nothing has run since — but a socket that
    // is somehow already shut would otherwise leave this one hanging.
    if (upstream.readyState !== WebSocket.OPEN) {
      ws.close(1001, "the app stopped answering");
    }
  },

  message(ws, message) {
    const { upstream } = ws.data;
    // A closing app has its close on the way to the browser already.
    if (upstream.readyState !== WebSocket.OPEN) return;
    upstream.send(message);
  },

  close(ws, code, reason) {
    const { upstream } = ws.data;
    if (upstream.readyState === WebSocket.CLOSED) return;
    // 1006 here is the browser gone without a close frame.
    if (code === 1006) upstream.close(1001, "the browser went away");
    else upstream.close(sendable(code) ? code : 1000, reason);
  },
};

function grant(
  runtime: AppsRuntime,
  request: Request,
  url: URL,
  target: AppTarget,
): Response {
  const token = url.searchParams.get("t") ?? "";
  const vouched = readGrant(runtime.app.config.dataDir, token, target);
  if (vouched === undefined) {
    return new Response("not found", { status: 404 });
  }
  const cookie = signGrant(
    runtime.app.config.dataDir,
    target,
    GRANT_COOKIE_TTL_MS,
    Date.now(),
    vouched.who,
  );
  const path = safePath(url.searchParams.get("to"));
  const secure =
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  return new Response(null, {
    status: 303,
    headers: {
      location: path,
      "set-cookie": `${grantCookieName(target)}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(GRANT_COOKIE_TTL_MS / 1000)}${secure ? "; Secure" : ""}`,
      "cache-control": "no-store",
    },
  });
}

/** A `to` a redirect may follow: this site's own paths, nothing else. */
function safePath(to: string | null): string {
  return to !== null && to.startsWith("/") && !to.startsWith("//") ? to : "/";
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * The page an environment that is not serving shows: what it is doing, in
 * words, with the run to look at. Never a bare gateway error.
 */
function unavailable(
  runtime: AppsRuntime,
  target: AppTarget,
  status: EnvStatus | undefined,
  reason?: string,
): Response {
  const name = target.app.slug;
  const where =
    target.env === "production"
      ? "production"
      : `the preview of pull #${target.env.slice(5)}`;
  const state = status?.state ?? "stopped";
  const deploying = state === "deploying";
  // A preview the forge no longer knows is gone, not broken: its pull closed
  // and its data went with it. That is a 404, which also lets this page
  // through an edge that replaces every 5xx with one of its own.
  const gone = status === undefined && target.env !== "production";
  const message =
    reason ??
    (deploying
      ? "A new version is starting."
      : state === "failed"
        ? (status?.error ?? "The last deploy failed.")
        : gone
          ? "This preview is gone: its pull was closed, and its data with it."
          : "Nothing is running here yet.");
  const report = reportUrl(runtime, target) !== undefined;
  const runLink =
    status?.runId === undefined
      ? ""
      : `<p><a href="${escape(runtime.options.forgeUrl)}/runs/${escape(status.runId)}">See the run on the forge</a></p>`;
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${deploying ? '<meta http-equiv="refresh" content="3">' : ""}
<title>${escape(name)} — ${deploying ? "starting" : gone ? "gone" : "not running"}</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 34rem; margin: 20vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; opacity: .85; }
  code { font-size: .9em; }
</style>
<h1>${escape(name)} ${deploying ? "is starting" : gone ? "is gone" : "is not running"}</h1>
<p>This is ${escape(where)}. ${escape(message)}</p>
${deploying ? "<p>This page refreshes on its own.</p>" : ""}
${runLink}
${report ? '<p><a href="/__forge/report">Report a problem</a> to the people who keep it; no account needed.</p>' : ""}
`;
  return new Response(html, {
    status: deploying ? 503 : gone ? 404 : 502,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(deploying ? { "retry-after": "3" } : {}),
      ...(report ? { link: REPORT_LINK } : {}),
    },
  });
}

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
