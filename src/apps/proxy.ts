/**
 * Apps on the forge's own port, by `Host`. `<slug>.<domain>` is production,
 * `<slug>--<n>.<domain>` the preview of pull `n`, `<slug>--b<sha7>.<domain>`
 * a build preview; the request is fetched
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

import { compressBytes, MIN_BYTES, negotiate } from "../http/compress.ts";
import type { Database } from "bun:sqlite";
import { getIssue, type Issue } from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import { mayView } from "../core/sealed.ts";
import { holds, weakEtag } from "../http/etag.ts";
import { holdOpen } from "../http/caller.ts";
import { appHostSuffix } from "./host.ts";
import { REPORT_LINK_TITLE } from "../actions/report_words.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import { getAppById, getAppBySlug, type AppRecord } from "../core/apps.ts";
import { getVerifiedDomain } from "../core/domains.ts";
import {
  canEnterApp,
  canWrite,
  canRead,
  getRepoById,
  type Repo,
  ownerInStanding,
} from "../core/repos.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { verifyToken } from "../core/tokens.ts";
import { getUserById, isActive, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { loadKey } from "../kernel/secret.ts";
import {
  buildEnvFromLabel,
  variantEnvFromLabel,
  envVariant,
  envBuild,
  envWords,
  previewEnv,
  type EnvName,
} from "./data.ts";
import type { AppsRuntime, EnvStatus } from "./runtime.ts";
import { crewNow, tellLink, yoursLink } from "./crew.ts";
import { sideOf, type Side } from "./side.ts";
import { feedback, mintProof } from "./feedback.ts";
import { clientBucket } from "../http/peer.ts";
import { DOOR_PULL_LIMIT, doorPage, type DoorPullLine } from "./door.ts";
import { checkWord } from "./check_word.ts";
import { servingWords } from "./serving_words.ts";
import { pillCheck } from "./pill_check.ts";
import { openPulls } from "./door_pulls.ts";
import { notePhase, startedAt, takePhases, timePhase } from "../core/route_timing.ts";
import { readServing } from "./serving.ts";
import { notFound, securityFloor } from "../http/respond.ts";
import { appMeasure } from "./measure.ts";
import { holdPortRequest, holdPortSocket } from "./handoff.ts";
import { secureFor } from "../http/cookie_secure.ts";
import { currentLoopLag, forgeWaited, LAG_WINDOW_MS } from "../perf/loop_worst.ts";
import { loopWatch } from "../perf/live.ts";
import { heldBy, noteRelayWait, stallTiming } from "./relay_wait.ts";
import { cspNonce, htmlAnswer, readPage, rewritable, TOOLBAR_ASSET_PATH, TOOLBAR_ASSET_PREFIX, toolbarResponse, withToolbar, type PillWhere } from "./toolbar.ts";

const proxySecure = (request: Request, url: URL, forgeUrl: string): boolean =>
  secureFor(url, forgeUrl) ||
  request.headers.get("x-forwarded-proto") === "https";

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
  // The app of ours is the tail of the label: `slug`, `slug--N` for the
  // preview of pull N, or `slug--b<sha7>` for a build preview (`b` and seven
  // hex digits is no slug: `isSlug`). Whatever comes before it belongs to the
  // app's own world — a forge hosted here has apps of its own, at
  // `<theirs>--<ours>` — and travels through untouched in `Host`, for that
  // app to route.
  const last = parts.at(-1)!;
  const build = parts.length >= 2 ? buildEnvFromLabel(last) : undefined;
  if (build !== undefined) {
    return { slug: parts.at(-2)!, env: build, nested: parts.length > 2 };
  }
  const variant = parts.length >= 2 ? variantEnvFromLabel(last) : undefined;
  if (variant !== undefined) {
    return { slug: parts.at(-2)!, env: variant, nested: parts.length > 2 };
  }
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
  // An app that already holds the slug `v-<label>` (made before that shape was
  // reserved) keeps its name: the host is it, in its parent's world, not a variant.
  const variant = envVariant(parsed.env);
  const held = variant === undefined ? undefined : getAppBySlug(app.db, `v-${variant}`);
  if (held !== undefined) {
    return shown(app, held) ? { app: held, env: "production", nested: true } : "unknown";
  }
  const record = getAppBySlug(app.db, parsed.slug);
  return record && shown(app, record)
    ? { app: record, env: parsed.env, nested: parsed.nested }
    : "unknown";
}

/**
 * An app whose repository's owner is suspended or removed has no host: it
 * answers as a name nobody holds, not as an app that is stopped (#831).
 */
function shown(app: App, record: AppRecord): boolean {
  const repo = getRepoById(app.db, record.repoId);
  return repo !== undefined && ownerInStanding(app.db, repo);
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
  return record === undefined || !shown(app, record)
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

/**
 * The forge's and the edge's credentials never reach tenant code: every
 * `x-plat-*` header, `authorization`, and this forge's grant cookie for
 * this app. Cookies are named, not swept by prefix: a forge hosted here
 * authenticates its own people with `forge_session` and `forge_grant_*`
 * on its own hostnames, and those are not ours to take. Our own session
 * cookie is host-only on the forge's host, so no app host ever receives it.
 */
export function stripForgeCredentials(
  headers: Headers,
  grantCookie: string,
): void {
  for (const name of [...headers.keys()])
    if (name.startsWith("x-plat-")) headers.delete(name);
  headers.delete("authorization");
  const cookie = headers.get("cookie");
  if (cookie === null) return;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.split("=", 1)[0]!.trim() !== grantCookie);
  if (kept.length === 0) headers.delete("cookie");
  else headers.set("cookie", kept.join("; "));
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

/**
 * The sealed pull a preview serves, when it serves one (`core/sealed.ts`):
 * a sealed report's fix, which only those who may see the report may open,
 * on a public app as on a private one.
 */
function sealedPull(runtime: AppsRuntime, target: AppTarget): Issue | undefined {
  const number = /^pull-(\d+)$/.exec(target.env)?.[1];
  if (number === undefined) return undefined;
  const pull = getIssue(runtime.app.db, target.app.repoId, Number(number));
  return pull?.sealed === true ? pull : undefined;
}

/**
 * The response with the phases the request named, as `Server-Timing`: the
 * one writer for the proxy, on the forge's own `/__forge/*` pages and, for
 * a reader who may see them (`relayAnswer`), on a relayed app answer. It appends, so an app's own entries stay first;
 * on an app answer the forge's phases are `forge-` named (`relayPhase`) so
 * none can collide with the app's or with the server's `route`.
 */
function withPhases(request: Request, res: Response): Response {
  const phases = takePhases(request);
  const stall = stallFor.get(request);
  if (stall !== undefined) {
    stallFor.delete(request);
    // An admin's copy names internal routes: never one a shared cache may keep.
    res.headers.set("cache-control", "private, no-store");
    res.headers.delete("etag");
  }
  if (phases.length === 0 && stall === undefined) return res;
  const named = phases.map((p) => `${p.name};dur=${p.ms.toFixed(1)}`);
  if (stall !== undefined) named.push(stall);
  const mine = named.join(", ");
  const theirs = res.headers.get("server-timing");
  res.headers.set("server-timing", theirs === null || theirs === "" ? mine : `${theirs}, ${mine}`);
  return res;
}

/**
 * A relayed app answer, with the forge's phases only for a reader who may
 * see them (#11112): someone who may write the app's repository, or a forge
 * admin. Everyone else gets the app's own Server-Timing exactly as it came;
 * how loaded the forge is and how long its lookups take are not a
 * stranger's to read. The app's speed card and /system read the same
 * numbers on the server side (`noteRelayWait`, the loop watch), never here.
 */
function relayAnswer(request: Request, res: Response): Response {
  if (forgeReaders.has(request)) return withPhases(request, res);
  takePhases(request);
  stallFor.delete(request);
  return res;
}

/** The requests whose reader is told the forge's phases (`relayAnswer`). */
const forgeReaders = new WeakSet<Request>();

/**
 * Whether the grant names someone told the forge's phases on this app: an
 * active person or agent who may write its repository, or a forge admin.
 * A visitor with no grant is never asked about, so a stranger costs no read.
 */
function readsForgeTiming(runtime: AppsRuntime, target: AppTarget, who: GrantWho | undefined): boolean {
  if (who === undefined) return false;
  const db = runtime.app.db;
  const viewer = getUserById(db, who.id);
  if (viewer === undefined || !isActive(viewer)) return false;
  // A forge admin, as `forgeAdmin` reads one: an agent never is.
  if (viewer.isAdmin && viewer.kind !== "agent") return true;
  const repo = getRepoById(db, target.app.repoId);
  return repo !== undefined && canWrite(db, repo, viewer);
}

/**
 * The forge's phases of relaying an app answer, `forge-` named. Durations
 * only, under these fixed names: `route` is `lookup` + `state` + `session`.
 */
type RelayPhase =
  | "route" | "lookup" | "state" | "session" | "wake"
  | "upstream" | "ttfb" | "lag" | "body" | "rewrite";

/** Name one of the forge's phases of relaying an app answer. Durations only. */
function relayPhase(request: Request, name: RelayPhase, ms: number): void {
  notePhase(request, `forge-${name}`, ms);
}

/**
 * Name `ttfb` and `upstream` for headers that took `headersMs`. `fetch` says
 * nothing of its connection, so the two are the same wait: `ttfb` is the name
 * the split reads by, `upstream` the total older readers know.
 *
 * Beside them, `forge-lag` (#10838): the forge's worst event-loop lag of the
 * last 10 s (`perf/loop_worst.ts`). `forge-ttfb` is read on the forge's clock,
 * so a loop blocked by something else lands in it while the app sat idle;
 * `forgeWaited` (the one place the rule lives) says when the wait was the forge's.
 */
function relayUpstream(
  runtime: AppsRuntime,
  request: Request,
  target: AppTarget,
  headersMs: number,
  who: GrantWho | undefined,
): void {
  const lag = currentLoopLag();
  relayPhase(request, "ttfb", headersMs);
  relayPhase(request, "lag", lag);
  relayPhase(request, "upstream", headersMs);
  // What held a wait that was the forge's (#11000): the stalls of the lag's
  // window, read only then — at most 40 of them, so the common relay pays nothing.
  const now = performance.now();
  const held = forgeWaited(lag, headersMs) ? heldBy(loopWatch.within(now - LAG_WINDOW_MS, now)) : [];
  // Production's slowest wait, for the app's speed card (`apps/relay_wait.ts`).
  if (target.env === "production") noteRelayWait(target.app.id, headersMs, lag, Date.now(), held);
  if (held.length > 0 && forgeAdmin(runtime, who)) stallFor.set(request, stallTiming(held));
}

/**
 * The `forge-stall` entries a relayed answer carries, by request, until
 * `withPhases` writes them. Set only for a forge admin: route patterns are
 * the forge's own, so nobody else sees them.
 */
const stallFor = new WeakMap<Request, string>();

/** Whether the grant names an active person who administers the forge (an agent never does). */
function forgeAdmin(runtime: AppsRuntime, who: GrantWho | undefined): boolean {
  if (who === undefined) return false;
  const user = getUserById(runtime.app.db, who.id);
  return user !== undefined && isActive(user) && user.isAdmin && user.kind !== "agent";
}

/**
 * What the pill says: the app, the environment and, for a preview, the pull
 * and its title. The title goes only to a viewer who may read the pull.
 */
export function pillWhere(
  runtime: AppsRuntime,
  target: AppTarget,
  who: GrantWho | undefined,
): PillWhere {
  const where: PillWhere = { app: target.app.slug, env: target.env };
  const db = runtime.app.db;
  const repo = getRepoById(db, target.app.repoId);
  if (repo === undefined) return where;
  const viewer = who === undefined ? undefined : getUserById(db, who.id);
  const user = viewer !== undefined && isActive(viewer) ? viewer : undefined;
  // An app's access is not its repository's: the name goes only to a reader.
  const reads = canRead(db, repo, user);
  if (reads) where.repo = `${repo.ownerName}/${repo.name}`;
  // What the forge's own record says is running here, for a reader of the repository only.
  const live = reads ? runtime.envStatus?.(target.app, target.env) : undefined;
  const liveAt = live?.servingAt ?? live?.since;
  if (live?.state === "running" && live.commitOid !== "" && liveAt !== undefined)
    where.serving = { oid: live.commitOid, at: liveAt };
  const number = /^pull-(\d+)$/.exec(target.env)?.[1];
  if (number === undefined) return where;
  where.pull = Number(number);
  const pull = getIssue(db, target.app.repoId, where.pull);
  if (pull === undefined) return where;
  if (!reads || !mayView(db, repo, pull, user)) return where;
  where.title = pull.title;
  const head = getPull(db, target.app.repoId, where.pull);
  if (head !== undefined && head.headOid !== "") where.check = pillCheck(db, pull.id, head.headOid);
  // How current the preview is: the row's head against the commit it runs. A
  // signed-in reader only, so a page an anonymous viewer may share never carries it.
  if (user === undefined) return where;
  if (head === undefined) return where;
  where.state = head.mergedAt !== null ? "merged" : head.state === "closed" ? "closed" : "open";
  // Only an open pull has a newer push to be behind.
  if (where.state !== "open") return where;
  const status = runtime.envStatus?.(target.app, target.env);
  if (status?.state === "deploying") where.deploying = true;
  where.behind = status?.state !== "deploying" && status?.commitOid !== undefined && status.commitOid !== head.headOid;
  return where;
}

/**
 * What the door says of the terminal: for a viewer who may write the
 * repository, the exact command (the preview's login on a preview), or null
 * when the terminal is off; for anyone else, nothing.
 */
function doorSsh(
  runtime: AppsRuntime,
  target: AppTarget,
  who: GrantWho | undefined,
): string | null | undefined {
  if (who === undefined) return undefined;
  const db = runtime.app.db;
  const viewer = getUserById(db, who.id);
  const repo = getRepoById(db, target.app.repoId);
  if (viewer === undefined || !isActive(viewer) || repo === undefined) return undefined;
  if (!canWrite(db, repo, viewer)) return undefined;
  if (runtime.envStatus(target.app, target.env)?.tty === null) return null;
  return runtime.sshFor(target.app, target.env) ?? null;
}

/**
 * The door's open pulls: a preview that is running or asleep links to itself,
 * every other pull to its page on the forge. Empty for whoever may not read.
 * Reads one more than the door draws, so it can say there are others.
 */
function doorPulls(
  runtime: AppsRuntime,
  target: AppTarget,
  who: GrantWho | undefined,
): DoorPullLine[] {
  const db = runtime.app.db;
  const repo = getRepoById(db, target.app.repoId);
  if (repo === undefined) return [];
  const viewer = who === undefined ? undefined : getUserById(db, who.id);
  return openPulls(db, repo, viewer, DOOR_PULL_LIMIT + 1).map((p) => {
    const env = previewEnv(p.number);
    const state = runtime.envStatus(target.app, env);
    const live =
      state !== undefined &&
      (state.state === "running" ||
        state.state === "asleep" ||
        state.dormant !== undefined);
    return {
      number: p.number,
      title: p.title,
      check: checkWord(p.run, p.headOid),
      ...(env === target.env ? { self: true } : {}),
      href: live
        ? runtime.urlFor(target.app, env)
        : new URL(
            `/${repo.ownerName}/${repo.name}/pulls/${p.number}`,
            runtime.options.forgeUrl,
          ).href,
    };
  });
}

/**
 * The pill's other side, for a signed-in reader of the repository only: the
 * pull titles it may name are the reader's own to see (`openPulls`).
 */
function sideFor(
  runtime: AppsRuntime,
  target: AppTarget,
  who: GrantWho | undefined,
): Side | null {
  if (who === undefined) return null;
  return sideForViewer(runtime, target.app, target.env, getUserById(runtime.app.db, who.id));
}

/** The repository, when `viewer` is an active reader of it: the only one the other side is told to. */
export function sideReader(db: App["db"], record: AppRecord, viewer: User | undefined): Repo | undefined {
  if (viewer === undefined || !isActive(viewer)) return undefined;
  const repo = getRepoById(db, record.repoId);
  return repo !== undefined && canRead(db, repo, viewer) ? repo : undefined;
}

/** The gate and the reading of the pill's other side, for the pill and the terminal alike. */
export function sideForViewer(
  runtime: Pick<AppsRuntime, "app" | "urlFor" | "envStatus">,
  record: AppRecord,
  env: EnvName,
  viewer: User | undefined,
): Side | null {
  const db = runtime.app.db;
  const repo = sideReader(db, record, viewer);
  if (repo === undefined || viewer === undefined) return null;
  const app = { url: runtime.urlFor(record, "production") };
  if (env !== "production") return sideOf(app, env, []);
  const previews = openPulls(db, repo, viewer, 50).flatMap((p) => {
    const penv = previewEnv(p.number);
    const status = runtime.envStatus(record, penv);
    if (status === undefined) return [];
    const state =
      status.state === "running"
        ? "running"
        : status.state === "asleep" || status.dormant !== undefined
          ? "asleep"
          : status.state;
    return [{ number: p.number, title: p.title, state, url: runtime.urlFor(record, penv) }];
  });
  return sideOf(app, env, previews);
}

/** Whether the person a grant names may enter this app now. */
function stillEntitled(
  runtime: AppsRuntime,
  target: AppTarget,
  grant: Grant,
): boolean {
  if (grant.who === undefined) return false;
  const repo = getRepoById(runtime.app.db, target.app.repoId);
  const user = getUserById(runtime.app.db, grant.who.id);
  const sealed = sealedPull(runtime, target);
  return (
    repo !== undefined &&
    user !== undefined &&
    isActive(user) &&
    canEnterApp(runtime.app.db, repo, target.app, user) &&
    (sealed === undefined || mayView(runtime.app.db, repo, sealed, user))
  );
}

/** What the app's host tells a signed-in reader it may not enter. */
export const NOT_ENTITLED_WORDS =
  "not found: this token can read the repository but may not enter its app. Ask a writer of the repository to add you to the app, or use a token of a writer or of the crew.";

const BEARER_GRANT_MS = 60_000;
/** Failed tokens one client may present per minute, across every app host. */
const BEARER_FAILURES_PER_MINUTE = 30;
const failedTokens = new WeakMap<App, RateLimiter>();

/**
 * A bearer token on a request to a guarded app, read the way the forge's
 * own API reads it. It admits when its person may enter the app; a run's
 * token only on the repository it was minted for; a proposal or via token never. A person who can read
 * the repository but not enter is told so (`hint`); anyone else — a token
 * that cannot read it, an expired one — gets nothing to learn from.
 */
function bearerAdmission(
  runtime: AppsRuntime,
  request: Request,
  target: AppTarget,
): {
  grant?: Grant;
  hint?: string;
  readOnly?: boolean;
  retryAfter?: number;
} | undefined {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return undefined;
  if (
    target.app.access !== "private" &&
    sealedPull(runtime, target) === undefined
  )
    return undefined;
  // Counted before the lookup, given back when the token is good: only
  // failures use up the allowance.
  let limiter = failedTokens.get(runtime.app);
  if (limiter === undefined) {
    limiter = new RateLimiter({
      perMinute: BEARER_FAILURES_PER_MINUTE,
      adminPerMinute: BEARER_FAILURES_PER_MINUTE,
      enabled: true,
    });
    failedTokens.set(runtime.app, limiter);
  }
  const key = clientBucket(request);
  const allowed = limiter.take(key, "ro");
  if (!allowed.allowed) return { retryAfter: allowed.retryAfter };
  const verified = verifyToken(runtime.app.db, header.slice(7));
  if (!verified.ok) return undefined;
  limiter.refund(key);
  const { user, run, scope, proposal, via } = verified.value;
  // A proposal token is a writer's token held by a child forge, and a via
  // token reaches /mcp alone: neither enters an app as the person who minted it.
  if (proposal !== undefined || via !== undefined) return undefined;
  const repo = getRepoById(runtime.app.db, target.app.repoId);
  if (repo === undefined) return undefined;
  if (run !== undefined && run.repoId !== repo.id && run.forkId !== repo.id)
    return undefined;
  if (!canRead(runtime.app.db, repo, user)) return undefined;
  const grant: Grant = {
    who: {
      id: user.id,
      name: user.username,
      // A read-only token is never an admin inside the app.
      role:
        scope !== "ro" && canWrite(runtime.app.db, repo, user)
          ? "admin"
          : "user",
    },
    expiresMs: Date.now() + BEARER_GRANT_MS,
  };
  return stillEntitled(runtime, target, grant)
    ? { grant, readOnly: scope === "ro" }
    : { hint: NOT_ENTITLED_WORDS };
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
  const cookieGrant =
    cookie === undefined
      ? undefined
      : readGrant(runtime.app.config.dataDir, cookie, target);
  // No browser, no cookie: a bearer token of someone who may enter is as
  // good as a grant for this one request (#7829).
  const bearer =
    cookieGrant === undefined
      ? bearerAdmission(runtime, request, target)
      : undefined;
  if (bearer?.retryAfter !== undefined)
    return err(
      new Response("too many failed tokens", {
        status: 429,
        headers: {
          "retry-after": String(bearer.retryAfter),
          "cache-control": "no-store",
        },
      }),
    );
  // A read-only token reads: the forge's API refuses it writes, and the
  // app's door is no wider.
  if (
    bearer?.readOnly === true &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  )
    return err(
      new Response("this token is read-only", {
        status: 403,
        headers: { "cache-control": "no-store" },
      }),
    );
  const signed = cookieGrant ?? bearer?.grant;
  // A private app's grant is asked again on every request whether the
  // person it names may still enter: a grant outlives a change of heart —
  // a writer removed, the app made private — by up to twelve hours, and
  // reading the repository was never enough (#620).
  // A grant names a person only while they are in good standing: a
  // suspended or removed account is no one to a public app, and nothing to
  // a private one.
  const named =
    signed?.who === undefined
      ? undefined
      : getUserById(runtime.app.db, signed.who.id);
  // A sealed pull's preview is held like a private app's, whatever the
  // app's own access: asked on every request.
  const guarded =
    target.app.access === "private" ||
    sealedPull(runtime, target) !== undefined;
  const lapsed =
    signed !== undefined &&
    ((guarded && !stillEntitled(runtime, target, signed)) ||
      (named !== undefined && !isActive(named)));
  const grant = lapsed ? undefined : signed;
  if (guarded) {
    if (grant === undefined) {
      // A person arriving by link is sent to the forge to sign in; it vouches
      // for them if they may enter the app and sends them back with the
      // grant, and otherwise gives the answer a private repository gives.
      // Anything that is not a person navigating — a script, an API call —
      // gets that answer here.
      const url = new URL(request.url);
      const navigating =
        bearer?.hint === undefined &&
        // A caller that presented a token is a script, not a person at a
        // link: it is answered, not sent to sign in.
        !(request.headers.get("authorization") ?? "").startsWith("Bearer ") &&
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
      return err(
        new Response(bearer?.hint ?? "not found", {
          status: 404,
          ...(bearer?.hint === undefined
            ? {}
            : { headers: { "content-type": "text/plain; charset=utf-8" } }),
        }),
      );
    }
  }
  // An archived repository's app is put away: stopped, its data kept, and
  // never woken by a visit.
  const repo = getRepoById(runtime.app.db, target.app.repoId);
  if (repo?.archivedAt != null) return err(archivedPage(target));
  // A preview stopped for want of attention is asked for: it deploys again
  // the ordinary way, and this request sees "starting" until it answers.
  // Read once; read again only when the rouse changed what it would say.
  let status = runtime.envStatus(target.app, target.env);
  if (status?.dormant !== undefined) {
    runtime.rouse(target.app, target.env);
    status = runtime.envStatus(target.app, target.env);
  }
  if (status === undefined || status.port === undefined) {
    return err(unavailable(runtime, target, status, undefined, grant?.who));
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
export function reportUrl(runtime: AppsRuntime, target: AppTarget): URL | undefined {
  const repo = publicRepo(runtime, target);
  return repo === undefined ? undefined : reportOf(runtime, repo);
}

/** The repository of an app that is public along with it, else nothing. */
function publicRepo(runtime: AppsRuntime, target: AppTarget): Repo | undefined {
  if (target.nested || target.app.access !== "public") return undefined;
  const repo = getRepoById(runtime.app.db, target.app.repoId);
  return repo !== undefined && canRead(runtime.app.db, repo, undefined)
    ? repo
    : undefined;
}

const reportOf = (runtime: AppsRuntime, repo: Repo): URL =>
  new URL(`/${repo.ownerName}/${repo.name}/report`, runtime.options.forgeUrl);

/** The link relation a public app's pages carry to `/__forge/report`. */
const REPORT_LINK =
  `</__forge/report>; rel="help"; title="${REPORT_LINK_TITLE}"`;

/** Names the forge's manifest, so it is told apart from an app's own alternate. */
export const REPO_LINK_TITLE = "this app's repository on its forge";

/**
 * The `Link` values a public app's pages carry: the report door and the
 * forge's role-aware manifest for the app's repository, so an agent that
 * landed on the app finds what it can do. One repository read serves both;
 * a private app, a nested host or a vanished repository gets none.
 */
export function discoveryLinks(runtime: AppsRuntime, target: AppTarget): string[] {
  const repo = publicRepo(runtime, target);
  if (repo === undefined) return [];
  const here = new URL("/api/v1/here", runtime.options.forgeUrl);
  here.search = `?path=${encodeURIComponent(`/${repo.ownerName}/${repo.name}`)}`;
  return [
    REPORT_LINK,
    `<${here.href}>; rel="alternate"; type="application/json"; title="${REPO_LINK_TITLE}"`,
  ];
}

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
  const entered = performance.now();
  const url = new URL(request.url);
  // The pill's script, from the app's own host: only the exact hashed path
  // is it; any other /__forge/toolbar… path is the forge's 404, never the app's.
  if (url.pathname.startsWith(TOOLBAR_ASSET_PREFIX) && !target.nested) {
    return securityFloor(
      url.pathname === TOOLBAR_ASSET_PATH &&
        (request.method === "GET" || request.method === "HEAD")
        ? toolbarResponse(request)
        : notFound(),
    );
  }
  // A grant with this forge's own token is answered here. On a nested
  // hostname a grant this forge did not sign is the guest forge's, and
  // goes through to it like any other request.
  if (url.pathname === "/__forge/grant") {
    const token = url.searchParams.get("t") ?? "";
    if (
      !target.nested ||
      verifyGrant(runtime.app.config.dataDir, token, target)
    )
      return securityFloor(grant(runtime, request, url, target));
  }
  // The two doors an app links to: sign in sends the visitor to the forge,
  // which vouches for them and sends them back named; sign out drops the
  // grant so the app hears nobody again.
  if (url.pathname === "/__forge/signin" && !target.nested) {
    const open = new URL("/apps/open", runtime.options.forgeUrl);
    open.searchParams.set("host", request.headers.get("host") ?? "");
    open.searchParams.set("to", safePath(url.searchParams.get("to")));
    return securityFloor(
      new Response(null, {
        status: 303,
        headers: { location: open.toString(), "cache-control": "no-store" },
      }),
    );
  }
  if (url.pathname === "/__forge/signout" && !target.nested) {
    const secure = proxySecure(request, url, runtime.options.forgeUrl);
    return securityFloor(
      new Response(null, {
        status: 303,
        headers: {
          location: safePath(url.searchParams.get("to")),
          "set-cookie": `${grantCookieName(target)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
          "cache-control": "no-store",
        },
      }),
    );
  }
  // The pill's fourth door: who of the crew is working on this app now,
  // for the person the app's own grant names, read once as the pill opens.
  if (url.pathname === "/__forge/crew" && !target.nested) {
    const signed = timePhase(request, "session", () => {
      const cookie = cookieValue(request, grantCookieName(target));
      return cookie === undefined
        ? undefined
        : readGrant(runtime.app.config.dataDir, cookie, target);
    });
    const crew = crewNow(
      runtime.app.db,
      runtime.options.forgeUrl,
      target.app,
      target.env,
      signed?.who?.id,
      request,
    );
    const tell = tellLink(
      runtime.app.db,
      runtime.options.forgeUrl,
      target.app,
      signed?.who?.id,
    );
    const yours =
      sealedPull(runtime, target) !== undefined
        ? undefined
        : yoursLink(runtime.app.db, runtime.options.forgeUrl, target.app, signed?.who?.id);
    const side =
      signed?.who === undefined
        ? null
        : timePhase(request, "side", () => sideFor(runtime, target, signed.who));
    const body = timePhase(request, "render", () =>
      JSON.stringify({
        ...crew,
        ...(tell === undefined ? {} : { tell }),
        ...(yours === undefined ? {} : { yours }),
        ...(side === null ? {} : { side }),
      }),
    );
    return withPhases(
      request,
      securityFloor(
        new Response(body, {
          headers: {
            "content-type": "application/json;charset=utf-8",
            "cache-control": "no-store",
          },
        }),
      ),
    );
  }
  // The forge's small page on the app's own host: the way back when the pill
  // is not shown. A nested host is its guest's, and has no such page.
  if (url.pathname === "/__forge/") {
    if (target.nested) return notFound();
    const signed = timePhase(request, "session", () => {
      const cookie = cookieValue(request, grantCookieName(target));
      return cookie === undefined
        ? undefined
        : readGrant(runtime.app.config.dataDir, cookie, target);
    });
    // A private app (or a sealed pull's preview) is not here to anyone it
    // does not admit: the answer is the one a name nobody holds gets, byte
    // for byte, before the method is even looked at.
    if (
      (target.app.access === "private" ||
        sealedPull(runtime, target) !== undefined) &&
      (signed === undefined || !stillEntitled(runtime, target, signed))
    )
      return securityFloor(new Response("not found", { status: 404 }));
    if (request.method !== "GET" && request.method !== "HEAD")
      return securityFloor(
        new Response(null, {
          status: 405,
          headers: { allow: "GET, HEAD" },
        }),
      );
    const tell = timePhase(request, "app", () =>
      tellLink(
        runtime.app.db,
        runtime.options.forgeUrl,
        target.app,
        signed?.who?.id,
      ),
    );
    const ssh = doorSsh(runtime, target, signed?.who);
    const report = reportUrl(runtime, target);
    const where = timePhase(request, "pull", () =>
      pillWhere(runtime, target, signed?.who),
    );
    const serving = timePhase(request, "serving", () =>
      readServing(runtime.app.db, target.app.repoId, target.env),
    );
    const pulls = timePhase(request, "pulls", () =>
      doorPulls(runtime, target, signed?.who),
    );
    const crew = crewNow(
      runtime.app.db,
      runtime.options.forgeUrl,
      target.app,
      target.env,
      signed?.who?.id,
      request,
    );
    const page = timePhase(request, "render", () =>
      doorPage(
        {
          where,
          pulls,
          ...(target.env === "production"
            ? {}
            : { live: runtime.urlFor(target.app, "production") }),
          ...(crew === undefined ? {} : { crew }),
          ...(serving === undefined ? {} : { serving }),
          forgeUrl: runtime.options.forgeUrl,
          ...(ssh === undefined ? {} : { ssh }),
          ...(report === undefined ? {} : { report: "/__forge/report" }),
          ...(tell === undefined ? { signin: "/__forge/signin" } : { tell }),
        },
        request.method === "HEAD",
      ),
    );
    return withPhases(request, page);
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
      return securityFloor(
        new Response(null, {
          status: 303,
          headers: { location: report.toString(), "cache-control": "no-store" },
        }),
      );
    }
  }
  // The forge button's feedback door: notes from visitors, their status, the
  // owner's moderation. Answered here, never reaching the app. A path under
  // /__forge/note that is none of its doors (`/__forge/notebook`) is the
  // app's own, and goes through below with the app's headers, not the floor.
  if (url.pathname.startsWith("/__forge/note") && !target.nested) {
    const cookie = cookieValue(request, grantCookieName(target));
    const signed =
      cookie === undefined
        ? undefined
        : readGrant(runtime.app.config.dataDir, cookie, target);
    // A private app or a sealed preview knows only the people it admits, as
    // /__forge/measure does; a lapsed grant is no grant.
    const sealed = sealedPull(runtime, target) !== undefined;
    const viewerId =
      (sealed || target.app.access === "private") && signed !== undefined && !stillEntitled(runtime, target, signed)
        ? undefined
        : signed?.who?.id;
    const answer = await feedback({
      app: runtime.app,
      forgeUrl: runtime.options.forgeUrl,
      request,
      url,
      record: target.app,
      env: target.env,
      sealed,
      viewerId,
      grantCookie: cookie,
      build: runtime.liveFor(target.app, target.env)?.commitOid,
      secure: proxySecure(request, url, runtime.options.forgeUrl),
      source: clientBucket(request),
    });
    if (answer !== undefined) return securityFloor(answer);
  }
  // The beacon's report: filed against this app, never waking it. A private
  // app (or a sealed pull's preview) admits only the people it admits, so
  // it keeps its visitors to itself.
  if (url.pathname === "/__forge/measure" && !target.nested) {
    if (target.app.access === "private" || sealedPull(runtime, target) !== undefined) {
      const admitted = admit(runtime, request, target);
      if (!admitted.ok) return securityFloor(admitted.error);
    }
    return securityFloor(await appMeasure(runtime.app, request, target));
  }
  // An environment asleep wakes for the request that wants it, and the
  // request waits the second that takes rather than seeing a closed door.
  let wakeMs = 0;
  if (runtime.envStatus(target.app, target.env)?.state === "asleep") {
    const woke = performance.now();
    await runtime.wake(target.app, target.env);
    wakeMs = performance.now() - woke;
  }
  const admitting = performance.now();
  const admitted = admit(runtime, request, target);
  const sessionMs = performance.now() - admitting;
  // A refused answer names no phases: wake runs before `admit`, so its time
  // would tell a caller who may not read the app whether it was asleep.
  if (!admitted.ok)
    return url.pathname.startsWith("/__forge/")
      ? securityFloor(admitted.error)
      : admitted.error;
  const { status, port, grant: vouched } = admitted.value;
  runtime.touch(target.app, target.env);
  if (readsForgeTiming(runtime, target, vouched?.who)) forgeReaders.add(request);
  const began = performance.now();
  // `route` split where it goes: the server finding the app (`lookup`), the
  // doors and the environment's state (`state`), the grant read (`session`).
  const lookupMs = Math.max(0, entered - (startedAt(request) ?? entered));
  relayPhase(request, "route", lookupMs + Math.max(0, began - entered - wakeMs));
  relayPhase(request, "lookup", lookupMs);
  relayPhase(request, "state", Math.max(0, began - entered - wakeMs - sessionMs));
  relayPhase(request, "session", sessionMs);
  relayPhase(request, "wake", wakeMs);

  const upstream = new URL(url);
  upstream.protocol = "http:";
  upstream.hostname = "127.0.0.1";
  upstream.port = String(port);
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  stripForgeCredentials(headers, grantCookieName(target));
  headers.set("x-forwarded-host", request.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  for (const [name, value] of Object.entries(
    identityHeaders(runtime.app.config.dataDir, target.app.id, vouched),
  ))
    headers.set(name, value);

  // A page the pill may be written into is asked for plain: the rewrite
  // cannot read a compressed body, and the proxy compresses what it wrote.
  const encoding = negotiate(request.headers.get("accept-encoding"));
  if (
    request.method === "GET" &&
    !target.nested &&
    status.toolbar !== false &&
    (request.headers.get("accept") ?? "").includes("text/html")
  ) {
    headers.set("accept-encoding", "identity");
    // The proxy compares after fetching: a tag it did not make would pair an
    // old toolbar with a new page.
    headers.delete("if-none-match");
  }

  if (isWebSocketHandshake(request)) {
    return proxyWebSocket(
      runtime,
      server,
      request,
      target,
      status,
      upstream,
      headers,
      vouched?.who,
    );
  }

  // Held from here until the answer begins: a slow answer is not idle.
  // And held against this deployment's port, so one being replaced
  // answers it before it is stopped (`apps/handoff.ts`).
  const envAnswered = runtime.holdRequest(target.app, target.env);
  const portAnswered = holdPortRequest(port);
  const answered = (): void => {
    envAnswered();
    portAnswered();
  };
  let response: Response;
  const sent = performance.now();
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
    answered();
    relayUpstream(runtime, request, target, performance.now() - sent, vouched?.who);
    return relayAnswer(request, unavailable(runtime, target, status, "the app stopped answering"));
  }
  relayUpstream(runtime, request, target, performance.now() - sent, vouched?.who);
  const out = new Headers(response.headers);
  for (const name of HOP_BY_HOP) out.delete(name);
  // Which app answered: a probe from outside (`spawn/reach.ts`) tells this
  // from a platform's standby page, which answers 200 for any name.
  out.set("x-forge-app", target.app.slug);
  // An agent reading a public app's page learns where to report a problem
  // without the app having to say so.
  if (isHtml(out))
    for (const link of discoveryLinks(runtime, target)) out.append("link", link);
  const eventStream =
    response.body !== null &&
    (response.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("text/event-stream");
  // An event stream takes its own hold before this one lets go.
  const body = eventStream
    ? held(runtime, target, response.body!)
    : response.body;
  answered();
  // The forge's pill goes into an HTML page the app sent whole and plain;
  // anything the proxy cannot rewrite safely goes through as it came. The
  // body is read after answered() on purpose, as the streaming path does: the
  // request hold covers the wait for the app's answer, not the client's read.
  if (
    request.method !== "HEAD" &&
    !target.nested &&
    status.toolbar !== false &&
    response.body !== null &&
    (rewritable(out, response.status) ||
      (!out.has("content-length") && htmlAnswer(out, response.status)))
  ) {
    const rewriting = performance.now();
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      if (out.has("content-length")) bytes = new Uint8Array(await response.arrayBuffer());
      else {
        // A streamed page is held only while it is small, quick and HTML;
        // past that it goes on as it came, what was read first.
        const read = await readPage(response.body);
        if (!read.whole)
          return relayAnswer(
            request,
            new Response(read.rest, {
              status: response.status,
              statusText: response.statusText,
              headers: out,
            }),
          );
        bytes = read.bytes;
      }
      relayPhase(request, "body", performance.now() - rewriting);
    } catch {
      return relayAnswer(request, unavailable(runtime, target, status, "the app stopped answering"));
    }
    // A signed-in person's page load gets the panel's one-use proof, and so
    // is theirs alone: never stored or shared. A page the app's own script
    // fetched (dest "empty", or a same-origin frame) gets none.
    const grantCookie = cookieValue(request, grantCookieName(target));
    const proof =
      vouched?.who !== undefined && grantCookie !== undefined && proofWanted(request)
        ? mintProof(grantCookie, request.headers.get("host") ?? "")
        : undefined;
    if (proof !== undefined) out.set("cache-control", "private, no-store");
    const page = timePhase(request, "rewrite", () =>
      withToolbar(
        bytes,
        runtime.options.forgeUrl,
        pillWhere(runtime, target, vouched?.who),
        proof,
        cspNonce(out.get("content-security-policy")),
      ),
    );
    let sent = page;
    // Whether it is gzipped depends on the client, so every copy says so.
    out.append("vary", "accept-encoding");
    if (
      encoding !== null &&
      page.length >= MIN_BYTES &&
      !out.has("content-encoding") &&
      !/\bno-transform\b/i.test(out.get("cache-control") ?? "")
    ) {
      sent = compressBytes(page, encoding) as Uint8Array<ArrayBuffer>;
      out.set("content-encoding", encoding);
    }
    out.set("content-length", String(sent.length));
    const upstreamTag = out.get("etag");
    out.delete("etag");
    out.delete("content-md5");
    // The same page for every viewer keeps a validator: the app's tag joined
    // with the bytes of what was sent, so a new toolbar is a new tag.
    const tag =
      upstreamTag !== null &&
      response.status === 200 &&
      request.method === "GET" &&
      proof === undefined &&
      vouched?.who === undefined &&
      out.getSetCookie().length === 0 &&
      cspNonce(out.get("content-security-policy")) === undefined &&
      !/\b(no-store|private)\b/i.test(out.get("cache-control") ?? "")
        ? weakEtag(`${upstreamTag}|${Bun.hash(page).toString(36)}`)
        : undefined;
    if (tag !== undefined) {
      out.set("etag", tag);
      if (holds(request, tag)) {
        out.delete("content-length");
        out.delete("content-encoding");
        relayPhase(request, "rewrite", performance.now() - rewriting);
        return relayAnswer(request, new Response(null, { status: 304, headers: out }));
      }
    }
    relayPhase(request, "rewrite", performance.now() - rewriting);
    return relayAnswer(
      request,
      new Response(sent, {
        status: response.status,
        statusText: response.statusText,
        headers: out,
      }),
    );
  }
  return relayAnswer(
    request,
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    }),
  );
}

/** Whether a request is a page load the panel may be proved on (see `mintProof`). */
export function proofWanted(request: Request): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest === null || dest === "document") return true;
  return dest === "iframe" && request.headers.get("sec-fetch-site") === "cross-site";
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
  /** The person the grant named, so their suspension can end the socket. */
  readonly userId: string | undefined;
  /** The forge the socket is held open on. */
  readonly db: Database;
  /** The deployment's loopback port, which a handoff drains (`apps/handoff.ts`). */
  readonly port: number;
}

/**
 * A proxied socket that names a person is held open under their account
 * (\`http/caller.ts\`): their suspension, seen by this process or swept
 * from the database, closes it.
 */
const heldSockets = new WeakMap<Bun.ServerWebSocket<AppSocket>, () => void>();

/** Each proxied socket's place among its deployment's, released when it closes. */
const portSockets = new WeakMap<Bun.ServerWebSocket<AppSocket>, () => void>();

/**
 * The most one frame may carry, in either direction. The browser's side is
 * enforced by Bun before a frame reaches us; the app's side is checked
 * here, because the client Bun gives us has no ceiling of its own. It is
 * also how much may queue for a browser that has stopped reading — past
 * it the socket is closed rather than the memory kept, and the forge never
 * buffers a frame on its own account.
 */
export const WS_MAX_MESSAGE = 16 * 1024 * 1024;
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
export const isWebSocketHandshake = (request: Request): boolean =>
  request.method === "GET" &&
  request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
  request.headers.has("sec-websocket-key");

/** The subprotocols a handshake offers, in the order it offers them. */
export const offeredProtocols = (request: Request): string[] =>
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
  who: GrantWho | undefined,
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
    data: { upstream, userId: who?.id, db: runtime.app.db, port: Number(url.port) },
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
export function connectUpstream(
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
export const appWebSocketWith = (
  maxMessage: number = WS_MAX_MESSAGE,
): Bun.WebSocketHandler<AppSocket> => ({
  maxPayloadLength: maxMessage,
  backpressureLimit: maxMessage,
  closeOnBackpressureLimit: true,
  idleTimeout: WS_IDLE_SECONDS,

  open(ws) {
    const { upstream, userId, db, port } = ws.data;
    portSockets.set(ws, holdPortSocket(port, ws));
    if (userId !== undefined)
      heldSockets.set(
        ws,
        holdOpen(db, userId, undefined, () => {
          if (ws.readyState === WebSocket.OPEN)
            closeBoth(ws, 1008, "this account was suspended");
        }),
      );
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
      if (size > maxMessage) {
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
    heldSockets.get(ws)?.();
    heldSockets.delete(ws);
    portSockets.get(ws)?.();
    portSockets.delete(ws);
    if (upstream.readyState === WebSocket.CLOSED) return;
    // 1006 here is the browser gone without a close frame.
    if (code === 1006) upstream.close(1001, "the browser went away");
    else upstream.close(sendable(code) ? code : 1000, reason);
  },
});

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
  const secure = proxySecure(request, url, runtime.options.forgeUrl);
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
export function unavailable(
  runtime: AppsRuntime,
  target: AppTarget,
  status: EnvStatus | undefined,
  reason?: string,
  who?: GrantWho,
): Response {
  const name = target.app.slug;
  const where =
    target.env.startsWith("pull-")
      ? `the preview of pull #${target.env.slice(5)}`
      : envWords(target.env);
  const state = status?.state ?? "stopped";
  const deploying = state === "deploying";
  // A preview is gone when its pull is closed, merged or no longer exists:
  // its data went with it. That is a 404, which also lets this page through
  // an edge that replaces every 5xx with one of its own. An open pull with no
  // environment is not gone: it deploys again on the next push.
  const at = pillWhere(runtime, target, who);
  const pull =
    at.pull === undefined
      ? undefined
      : getIssue(runtime.app.db, target.app.repoId, at.pull);
  const preview = target.env !== "production";
  const gone = preview && (pull === undefined || pull.state === "closed");
  // Nothing was ever deployed for an open pull: also a 404, for the same
  // edge, since there is nothing at this address yet. A stopped or failed
  // environment keeps its 502.
  const absent = preview && !gone && status === undefined;
  const words = servingWords(status, preview ? (gone ? "closed" : "open") : null);
  const build = envBuild(target.env) !== undefined;
  const message =
    reason ??
    (build && gone
      ? "This build preview is gone: it was taken down, and its data with it. Ask for it again from the app's builds."
      : words.says);
  const links = discoveryLinks(runtime, target);
  const report = links.length > 0;
  const runLink =
    status?.runId === undefined
      ? ""
      : `<p><a href="${escape(runtime.options.forgeUrl)}/runs/${escape(status.runId)}">See the run on the forge</a></p>`;
  const forge = runtime.options.forgeUrl;
  const exits: string[] = [];
  if (preview && at.repo !== undefined && at.pull !== undefined) {
    const href = new URL(`/${at.repo}/pulls/${at.pull}`, forge).href;
    exits.push(
      `<a href="${escape(href)}">Pull #${at.pull}${at.title === undefined ? "" : `: ${escape(at.title)}`}</a>`,
    );
  }
  // A private app's address, like its repository's name, goes only to a reader.
  const mayNameProduction = target.app.access === "public" || at.repo !== undefined;
  if (
    preview &&
    mayNameProduction &&
    runtime.envStatus(target.app, "production")?.port !== undefined
  )
    exits.push(`<a href="${escape(runtime.urlFor(target.app, "production"))}">Production</a>`);
  exits.push(`<a href="${escape(new URL("/", forge).href)}">Forge home</a>`);
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
<p>${exits.join(" · ")}</p>
${report ? '<p><a href="/__forge/report">Report a problem</a> to the people who keep it; no account needed.</p>' : ""}
`;
  return new Response(html, {
    status: deploying ? 503 : gone || absent ? 404 : 502,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(deploying ? { "retry-after": "3" } : {}),
      ...(report ? { link: links.join(", ") } : {}),
    },
  });
}

/** The short page an archived repository's app answers with: 503, not a 502. */
function archivedPage(target: AppTarget): Response {
  const name = escape(target.app.slug);
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — archived</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 34rem; margin: 20vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; opacity: .85; }
</style>
<h1>${name} is archived</h1>
<p>Its people have put it away. It is not running, and its data is kept.</p>
`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
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
