/**
 * "What forge is this?" — asked cheapest-first, and answered honestly.
 *
 * The tidy answer would be NodeInfo (`/.well-known/nodeinfo`), the one thing
 * in this space resembling a standard. It does not work: Forgejo specifies
 * `/api/v1/nodeinfo` and no live instance serves it — codeberg.org,
 * code.forgejo.org and git.disroot.org all 404 the well-known path. So the
 * primary probe is `GET /api/v1/version`, which every Forgejo and Gitea
 * answers, and the discriminator is its version string: Forgejo appends the
 * Gitea API generation it implements (`16.0.1+gitea-1.22.0`), Gitea's never
 * contains `+gitea-`. NodeInfo stays as an opportunistic first look, because
 * it costs one request and would be the right answer if anyone shipped it.
 *
 * Everything here talks to a host the user just named, so it is written like
 * a fetch of hostile input: short timeouts, a byte cap, and a hard rule that
 * a redirect may never leave the host we asked.
 */

import {
  outboundFetch,
  type OutboundOptions,
  RefusedError,
  vetHost,
} from "../kernel/outbound.ts";
import { trustedHosts } from "./trusted-hosts.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { readCapped } from "./providers/http.ts";
import type { Discovered, OriginKind } from "./types.ts";

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const MAX_HOPS = 3;

export type DiscoverError = "unknown_host" | "unreachable" | "private_host";

export interface DiscoverInput {
  /** What the user typed: `github`, `github.com`, `https://codeberg.org`. */
  host: string;
  /** Set when the user picked a forge explicitly (GitHub Enterprise needs it). */
  kind?: OriginKind;
}

/**
 * Hosts an operator has explicitly vouched for, comma-separated. This is the
 * one way to reach a LAN forge or a plaintext one — an operator decision,
 * never a per-user toggle, because the risk it accepts is the server's.
 */
function allowedHosts(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.FORGE_ORIGIN_ALLOW ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ""),
  );
}

/**
 * Whether the operator named this URL's host in `FORGE_ORIGIN_ALLOW`: its
 * `host:port` for that port, or its bare hostname for every port. Discovery
 * reads it, and so does the mirror's git (`origins/git-mirror.ts`), so a
 * host an origin may be connected from is a host it may be mirrored from.
 */
export function operatorAllowed(
  href: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const url = URL.parse(href);
  if (url === null) return false;
  const allowed = allowedHosts(env);
  return (
    allowed.has(url.host.toLowerCase()) ||
    allowed.has(url.hostname.toLowerCase())
  );
}

/** A development instance (`FORGE_DEV=1`, also set for the test suite). */
function isDev(env: Record<string, string | undefined>): boolean {
  return env.FORGE_DEV === "1";
}

/** Loopback is this machine: reachable in dev, where a development instance
 * and the test suite live, and nowhere else unless an operator names it. */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * A literal address inside a range a server has no business dialling on a
 * user's say-so. Only literals are checked here: a name that *resolves* into
 * one of these ranges still gets through, and closing that would mean
 * resolving the host ourselves and connecting to the pinned address, which
 * Bun's fetch gives us no hook for. That residual DNS-rebinding risk is
 * stated rather than papered over; the allow-list is the mitigation.
 */
function isPrivateV4(a: number, b: number): boolean {
  if (a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true; // loopback, reached via a mapped form
  return false;
}

function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isPrivateV4(Number(v4[1]), Number(v4[2]));
  if (
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  )
    return true;
  // WHATWG URL parsing folds an IPv4-mapped/compatible IPv6 literal — and the
  // IPv4 shorthands that feed one (`127.1`, hex, octal, decimal) — down to a
  // bare IPv6 address whose last two hextets are the IPv4 octet pairs:
  // `[::ffff:169.254.169.254]` becomes hostname `::ffff:a9fe:a9fe`. Left
  // unchecked that is a live bypass onto the cloud metadata address (and
  // every other private range above) through a form neither `isLoopback` nor
  // the dotted-quad branch above ever sees. Decode it back to octets and
  // check those.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = Number.parseInt(mapped[1]!, 16);
    const lo = Number.parseInt(mapped[2]!, 16);
    return (
      isPrivateV4((hi >> 8) & 0xff, hi & 0xff) ||
      isPrivateV4((lo >> 8) & 0xff, lo & 0xff)
    );
  }
  return false;
}

/**
 * A user-typed host, normalised to an origin (scheme + host + port) — and
 * refused unless the forge is willing to make requests to it.
 *
 * The user names a host and the server fetches it, which is textbook SSRF.
 * The policy: https only; plaintext http only for loopback or an
 * operator-allowed host; and no private address literal unless allowed.
 */
export function allowedOrigin(
  input: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const text = input.trim().replace(/\/+$/, "");
  if (text === "") return undefined;
  // A scheme that is not http(s) is refused outright rather than treated as
  // a hostname: `file:///etc/passwd` must never become `https://file/…`.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return undefined;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.hostname === "") return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  if (operatorAllowed(url.href, env)) return url.origin;
  if (isDev(env) && isLoopback(url.hostname)) return url.origin;
  if (url.protocol !== "https:") return undefined;
  if (isPrivateLiteral(url.hostname)) return undefined;
  return url.origin;
}

export async function discover(
  input: string | DiscoverInput,
  env: Record<string, string | undefined> = process.env,
  given: OutboundOptions = {},
): Promise<Result<Discovered, DiscoverError>> {
  const options: OutboundOptions = { trusted: trustedHosts(), ...given };
  const wanted: DiscoverInput =
    typeof input === "string" ? { host: input } : input;
  const typed = wanted.host.trim().toLowerCase().replace(/\/+$/, "");

  // github.com is known — there is nothing to probe and no NodeInfo to find.
  if (
    typed === "github" ||
    typed === "github.com" ||
    typed === "https://github.com" ||
    typed === "api.github.com" ||
    (wanted.kind === "github" && typed === "")
  ) {
    return ok({
      kind: "github",
      apiUrl: "https://api.github.com",
      webUrl: "https://github.com",
      via: "known",
      software: "github",
    });
  }

  const web = allowedOrigin(wanted.host, env);
  if (web === undefined) return err("unknown_host");
  const probe: Probe = { env, options, refused: false };
  if (!exempt(web, env)) {
    const vetted = await vetHost(new URL(web).hostname, options);
    if (!vetted.ok && vetted.error === "refused") return err("private_host");
  }

  // GitHub Enterprise publishes neither NodeInfo nor a version endpoint we
  // can read unauthenticated; the user says so, and we believe them.
  if (wanted.kind === "github") {
    return ok({
      kind: "github",
      apiUrl: `${web}/api/v3`,
      webUrl: web,
      via: "known",
      software: "github-enterprise",
    });
  }

  // One cheap look at the standard, then the probe that actually answers.
  const node = await viaNodeInfo(web, probe);
  if (node) return ok(node);

  const version = await viaVersionEndpoint(web, probe);
  if (version) return ok(version);

  // A forge from before `/api/v1/version` still answers health and here.
  const older = await viaOlderForge(web, probe);
  if (older) return ok(older);

  return err(probe.refused ? "private_host" : "unreachable");
}

// ---- probes ----

/**
 * The version endpoint, and the undocumented fact that makes it a
 * discriminator: `+gitea-<semver>` in the string means Forgejo declaring
 * which Gitea API generation it implements. Gitea's own string never has it.
 */
async function viaVersionEndpoint(
  web: string,
  probe: Probe,
): Promise<Discovered | undefined> {
  const doc = await getJson(`${web}/api/v1/version`, web, probe);
  if (!doc.ok) return undefined;
  const version = asString(field(doc.value, "version"));
  if (version === "") return undefined;
  // Another forge of this kind says so, and speaks the Gitea dialect: it is
  // stored as a Gitea origin and shown as a forge (`docs/features/forge-origin.md`).
  const forge = asString(field(doc.value, "software")) === "forge";
  const kind: OriginKind = version.includes("+gitea-") ? "forgejo" : "gitea";
  return {
    kind,
    apiUrl: `${web}/api/v1`,
    webUrl: web,
    via: "version-endpoint",
    software: forge ? `forge ${version}` : version,
  };
}

/**
 * A forge too old to answer `/api/v1/version` (0.5.x). It is known by two
 * answers no other software gives together: `/api/v1/health` with a boolean
 * `ok` and a dotted `version`; and either its OAuth metadata naming its own
 * `/oauth/authorize` and `/oauth/register`, or a `commit` beside `/api/v1/here`
 * with the manifest's `here` and `actions`. Its repositories are then listed through
 * `GET /api/v1/repos` (`ForgeProvider.listRepos`).
 */
async function viaOlderForge(
  web: string,
  probe: Probe,
): Promise<Discovered | undefined> {
  const health = await getJson(`${web}/api/v1/health`, web, probe);
  if (!health.ok) return undefined;
  const version = asString(field(health.value, "version"));
  if (
    typeof field(health.value, "ok") !== "boolean" ||
    !/^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,40}$/.test(version)
  )
    return undefined;
  if (!(await oauthPathsAreForges(web, probe))) {
    if (asString(field(health.value, "commit")) === "") return undefined;
    const here = await getJson(`${web}/api/v1/here`, web, probe);
    if (
      !here.ok ||
      typeof field(here.value, "here") !== "object" ||
      field(here.value, "here") === null ||
      !Array.isArray(field(here.value, "actions"))
    )
      return undefined;
  }
  return {
    kind: "gitea",
    apiUrl: `${web}/api/v1`,
    webUrl: web,
    via: "health",
    software: `forge ${version}`,
  };
}

/** A forge's OAuth metadata names `/oauth/authorize` and `/oauth/register`; Forgejo's and Gitea's do not. */
async function oauthPathsAreForges(web: string, probe: Probe): Promise<boolean> {
  const doc = await getJson(`${web}/.well-known/oauth-authorization-server`, web, probe);
  if (!doc.ok) return false;
  const path = (name: string): string | undefined => URL.parse(asString(field(doc.value, name)))?.pathname;
  return path("authorization_endpoint") === "/oauth/authorize" && path("registration_endpoint") === "/oauth/register";
}

async function viaNodeInfo(
  web: string,
  probe: Probe,
): Promise<Discovered | undefined> {
  const index = await getJson(`${web}/.well-known/nodeinfo`, web, probe);
  if (!index.ok) return undefined;
  const links = asArray(field(index.value, "links"));
  // Prefer the newest schema the host offers; any of them carries `software`.
  const hrefs = links
    .map((link) => asString(field(link, "href")))
    .filter((href) => href !== "")
    .sort()
    .reverse();

  for (const href of hrefs.slice(0, 3)) {
    // A NodeInfo document on another host is a redirect we did not consent to.
    if (!sameOrigin(href, web)) continue;
    const doc = await getJson(href, web, probe);
    if (!doc.ok) continue;
    const name = asString(field(field(doc.value, "software"), "name"))
      .trim()
      .toLowerCase();
    const kind =
      name === "forgejo" ? "forgejo" : name === "gitea" ? "gitea" : undefined;
    if (kind === undefined) continue;
    return {
      kind,
      apiUrl: `${web}/api/v1`,
      webUrl: web,
      via: "nodeinfo",
      software: name,
    };
  }
  return undefined;
}

// ---- careful fetching ----

/** What one discovery carries between its requests. */
interface Probe {
  env: Record<string, string | undefined>;
  options: OutboundOptions;
  /** Set when any hop was refused for its address. */
  refused: boolean;
}

/** An operator-named host, or loopback in dev: dialled as typed, unvetted. */
function exempt(
  href: string,
  env: Record<string, string | undefined>,
): boolean {
  return (
    operatorAllowed(href, env) ||
    (isDev(env) && isLoopback(new URL(href).hostname))
  );
}

function sameOrigin(href: string, web: string): boolean {
  try {
    return new URL(href).origin === web;
  } catch {
    return false;
  }
}

/**
 * GET a small JSON document, following redirects by hand so every hop can be
 * checked against the host the user named. Any failure is just `undefined`
 * to the caller: discovery is a guess, and a wrong guess is not an error.
 */
async function getJson(
  url: string,
  web: string,
  probe: Probe,
): Promise<Result<unknown, "failed">> {
  let target = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!sameOrigin(target, web)) {
      // Say so when the hop it was sent to is inside the network.
      if (!exempt(target, probe.env)) {
        const vetted = await vetHost(new URL(target).hostname, probe.options);
        if (!vetted.ok && vetted.error === "refused") probe.refused = true;
      }
      return err("failed");
    }
    const init = {
      headers: { accept: "application/json", "user-agent": "forge" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    } satisfies RequestInit;
    let response: Response;
    try {
      // Vetted, pinned to the judged address, and never auto-followed.
      response = exempt(target, probe.env)
        ? await fetch(target, init)
        : await outboundFetch(target, init, probe.options);
    } catch (e) {
      if (e instanceof RefusedError) probe.refused = true;
      return err("failed");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) return err("failed");
      try {
        target = new URL(location, target).toString();
      } catch {
        return err("failed");
      }
      continue;
    }
    if (!response.ok) return err("failed");
    let text: string | undefined;
    try {
      // Streamed and cut at the cap, so an oversized answer is dropped at
      // the cap rather than buffered whole and then declined.
      text = await readCapped(response, MAX_BYTES);
    } catch {
      return err("failed");
    }
    if (text === undefined) return err("failed");
    try {
      return ok(JSON.parse(text));
    } catch {
      return err("failed");
    }
  }
  return err("failed");
}

// ---- tiny JSON readers (remote JSON is never trusted to have a shape) ----

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
