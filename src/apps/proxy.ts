/**
 * Apps on the forge's own port, by `Host`. `<slug>.<domain>` is production,
 * `<slug>--<n>.<domain>` the preview of pull `n`; the request is fetched
 * from the deployment's loopback port and streamed back.
 *
 * A private app answers only to a visitor the forge has vouched for. The
 * app's host sets no cookie of its own; the forge sends the visitor to
 * `/__forge/grant?t=…` on the app's host with a token it signed after
 * checking `canRead`, and that handler sets the grant cookie. Nothing on
 * the app host can mint one — the key never leaves the forge's data
 * directory — so guessing a hostname yields the forge's own "not found".
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import { getAppBySlug, type AppRecord } from "../core/apps.ts";
import { loadKey } from "../kernel/secret.ts";
import { previewEnv, type EnvName } from "./data.ts";
import type { AppsRuntime, EnvStatus } from "./runtime.ts";

export interface AppTarget {
  readonly app: AppRecord;
  readonly env: EnvName;
}

/**
 * Which app and environment a `Host` names, if any. Hostnames are
 * case-insensitive and may carry a port. Only one label may sit in front
 * of the domain: `a.b.<domain>` is not an app.
 */
export function parseAppHost(
  hostHeader: string,
  domain: string,
): { slug: string; env: EnvName } | undefined {
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${domain.toLowerCase().replace(/:\d+$/, "")}`;
  if (!host.endsWith(suffix)) return undefined;
  const label = host.slice(0, -suffix.length);
  if (label === "" || label.includes(".")) return undefined;
  const at = label.indexOf("--");
  if (at === -1) return { slug: label, env: "production" };
  const slug = label.slice(0, at);
  const number = label.slice(at + 2);
  if (!/^[1-9]\d*$/.test(number) || slug === "") return undefined;
  return { slug, env: previewEnv(Number(number)) };
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
  const parsed = parseAppHost(host, domain);
  if (parsed === undefined) return undefined;
  const record = getAppBySlug(app.db, parsed.slug);
  return record ? { app: record, env: parsed.env } : "unknown";
}

const GRANT_COOKIE = "forge_grant";
const GRANT_URL_TTL_MS = 2 * 60_000;
const GRANT_COOKIE_TTL_MS = 12 * 60 * 60_000;

/** A signed grant: `<app id>.<env>.<expiry ms>.<signature>`. */
export function signGrant(
  dataDir: string,
  target: AppTarget,
  ttlMs: number,
  now = Date.now(),
): string {
  const payload = `${target.app.id}.${target.env}.${now + ttlMs}`;
  return `${payload}.${mac(dataDir, payload)}`;
}

function mac(dataDir: string, payload: string): string {
  return createHmac("sha256", loadKey(dataDir))
    .update(payload)
    .digest("base64url");
}

/** Whether `grant` vouches for this target right now. */
export function verifyGrant(
  dataDir: string,
  grant: string,
  target: AppTarget,
  now = Date.now(),
): boolean {
  const parts = grant.split(".");
  if (parts.length !== 4) return false;
  const [appId, env, expires, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (appId !== target.app.id || env !== target.env) return false;
  if (!/^\d+$/.test(expires) || Number(expires) <= now) return false;
  const expected = mac(dataDir, `${appId}.${env}.${expires}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The URL the forge redirects a vouched-for visitor to. */
export function grantUrl(
  runtime: AppsRuntime,
  target: AppTarget,
  path = "/",
): string {
  const token = signGrant(runtime.app.config.dataDir, target, GRANT_URL_TTL_MS);
  const base = runtime.urlFor(target.app, target.env);
  return `${base}/__forge/grant?t=${encodeURIComponent(token)}&to=${encodeURIComponent(path)}`;
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

/** Serve a request addressed to an app. */
export async function proxyApp(
  runtime: AppsRuntime,
  request: Request,
  target: AppTarget,
): Promise<Response> {
  const url = new URL(request.url);
  const status = runtime.envStatus(target.app, target.env);

  if (url.pathname === "/__forge/grant") {
    return grant(runtime, request, url, target);
  }
  if (target.app.access === "private") {
    const cookie = cookieValue(request, GRANT_COOKIE);
    if (
      cookie === undefined ||
      !verifyGrant(runtime.app.config.dataDir, cookie, target)
    ) {
      // The same answer the forge gives for a repository you cannot see.
      return new Response("not found", { status: 404 });
    }
  }
  if (status === undefined || status.port === undefined) {
    return unavailable(runtime, target, status);
  }
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return new Response("websockets are not proxied to apps yet", {
      status: 501,
    });
  }

  const upstream = new URL(url);
  upstream.protocol = "http:";
  upstream.hostname = "127.0.0.1";
  upstream.port = String(status.port);
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set("x-forwarded-host", request.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
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
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}

function grant(
  runtime: AppsRuntime,
  request: Request,
  url: URL,
  target: AppTarget,
): Response {
  const token = url.searchParams.get("t") ?? "";
  if (!verifyGrant(runtime.app.config.dataDir, token, target)) {
    return new Response("not found", { status: 404 });
  }
  const cookie = signGrant(
    runtime.app.config.dataDir,
    target,
    GRANT_COOKIE_TTL_MS,
  );
  const to = url.searchParams.get("to") ?? "/";
  const path = to.startsWith("/") && !to.startsWith("//") ? to : "/";
  const secure =
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  return new Response(null, {
    status: 303,
    headers: {
      location: path,
      "set-cookie": `${GRANT_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(GRANT_COOKIE_TTL_MS / 1000)}${secure ? "; Secure" : ""}`,
      "cache-control": "no-store",
    },
  });
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
  const message =
    reason ??
    (deploying
      ? "A new version is starting."
      : state === "failed"
        ? (status?.error ?? "The last deploy failed.")
        : "Nothing is running here yet.");
  const runLink =
    status?.runId === undefined
      ? ""
      : `<p><a href="${escape(runtime.options.forgeUrl)}/runs/${escape(status.runId)}">See the run on the forge</a></p>`;
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${deploying ? '<meta http-equiv="refresh" content="3">' : ""}
<title>${escape(name)} — ${deploying ? "starting" : "not running"}</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 34rem; margin: 20vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; opacity: .85; }
  code { font-size: .9em; }
</style>
<h1>${escape(name)} ${deploying ? "is starting" : "is not running"}</h1>
<p>This is ${escape(where)}. ${escape(message)}</p>
${deploying ? "<p>This page refreshes on its own.</p>" : ""}
${runLink}
`;
  return new Response(html, {
    status: deploying ? 503 : 502,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(deploying ? { "retry-after": "3" } : {}),
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
