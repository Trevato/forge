/**
 * Cart captures: the one page a pin releases, saved once from its running
 * build. A capture is the cart itself — what the Arcade plays and what
 * Download hands over — so it never has to wait for a preview again.
 *
 * Captures live in the data directory, at
 * `carts/<owner>/<repo>/<sha>/<page>.html`, with a picture of the page
 * beside it as `<page>.png` for the cover. A file there is never written
 * twice: the commit is fixed, so its page is too.
 *
 * Capturing is the slow part: the build's preview is started if it is not
 * running, waited for, and asked for the page. It runs in the background;
 * what a panel shows meanwhile is held in memory, and a forge coming back
 * simply shows the capture as missing, with Capture again beside it.
 */

import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "../app.ts";
import { previewBuild, type PreviewBuildError } from "../actions/build_preview.ts";
import { buildEnv } from "../apps/data.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAppByRepo } from "../core/apps.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isDemoPage } from "../git/builds.ts";
import { isSafeOid } from "../git/guard.ts";
import { takeLook, type Capture } from "../looks/capture.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";

const log = createLog("carts");

export const cartsRoot = (dataDir: string): string => join(dataDir, "carts");

/** A page's file name: `/` is `index`, `/spicy` is `spicy`. */
export const pageFile = (page: string): string =>
  page === "/" ? "index" : page.slice(1).replaceAll("/", "-");

/** Where a commit's page is kept, without its extension. */
export function capturePath(dataDir: string, repo: Pick<Repo, "ownerName" | "name">, oid: string, page: string): string {
  return join(cartsRoot(dataDir), repo.ownerName, repo.name, oid, pageFile(page));
}

const valid = (oid: string, page: string): boolean => isSafeOid(oid) && /^[0-9a-f]{40,64}$/.test(oid) && isDemoPage(page);

/** The captured page, or undefined. */
export function readCapture(dataDir: string, repo: Pick<Repo, "ownerName" | "name">, oid: string, page: string): Uint8Array | undefined {
  if (!valid(oid, page)) return undefined;
  const path = `${capturePath(dataDir, repo, oid, page)}.html`;
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
}

/** The picture of the captured page, or undefined. */
export function readArt(dataDir: string, repo: Pick<Repo, "ownerName" | "name">, oid: string, page: string): Uint8Array | undefined {
  if (!valid(oid, page)) return undefined;
  const path = `${capturePath(dataDir, repo, oid, page)}.png`;
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
}

/**
 * Write `bytes` at `path` only if nothing is there: written to one side,
 * then linked in, which fails rather than replace a file. False when a
 * file was already there.
 */
export function writeOnce(path: string, bytes: Uint8Array): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.${process.pid}.${Date.now()}.part`;
  writeFileSync(staged, bytes);
  try {
    linkSync(staged, path);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Store a capture made elsewhere — the forge CLI's import. False if one is there. */
export function importCapture(
  dataDir: string,
  repo: Pick<Repo, "ownerName" | "name">,
  oid: string,
  page: string,
  html: Uint8Array,
  art?: Uint8Array,
): Result<boolean, "invalid"> {
  if (!valid(oid, page)) return err("invalid");
  const base = capturePath(dataDir, repo, oid, page);
  const wrote = writeOnce(`${base}.html`, html);
  if (art !== undefined) writeOnce(`${base}.png`, art);
  return ok(wrote);
}

export type CaptureError =
  | PreviewBuildError
  | "not_an_app"
  | "invalid"
  | "build_failed"
  | "timed_out"
  | "page_missing";

export type CaptureState =
  | { readonly state: "done" }
  | { readonly state: "capturing" }
  | { readonly state: "failed"; readonly error: CaptureError; readonly detail?: string }
  | { readonly state: "none" };

/** What a capture under way, or one that failed, looks like this boot. */
const jobs = new WeakMap<App, Map<string, CaptureState>>();
const jobKey = (repo: Repo, oid: string, page: string): string => `${repo.id}:${oid}:${page}`;
const jobsOf = (app: App): Map<string, CaptureState> => {
  let map = jobs.get(app);
  if (map === undefined) jobs.set(app, (map = new Map()));
  return map;
};

/** Whether a page is captured, being captured, or failed. */
export function captureState(app: App, repo: Repo, oid: string, page: string): CaptureState {
  if (!valid(oid, page)) return { state: "none" };
  if (existsSync(`${capturePath(app.config.dataDir, repo, oid, page)}.html`)) return { state: "done" };
  return jobsOf(app).get(jobKey(repo, oid, page)) ?? { state: "none" };
}

export interface CaptureOptions {
  /** How long the build may take to come up. */
  readonly waitMs?: number;
  /** What takes the picture; a test passes a stand-in. */
  readonly picture?: Capture;
  /** The commit's build preview; by default the app's own (`previewOf`). */
  readonly build?: Build;
  /** How often the build is looked at while it comes up. */
  readonly pollMs?: number;
}

/** A commit's build preview, as a capture sees it: how it stands, and how to start it. */
export interface Build {
  readonly up: () => { readonly state: string; readonly port?: number | undefined } | undefined;
  readonly start: () => Promise<Result<unknown, CaptureError>>;
}

/** The build preview of `oid` in `repo`'s app, or undefined when it is no app. */
function previewOf(app: App, actor: User | undefined, repo: Repo, oid: string): Build | undefined {
  const record = getAppByRepo(app.db, repo.id);
  const runtime = appsRuntime(app);
  if (record === undefined || runtime === undefined) return undefined;
  const env = buildEnv(oid);
  return {
    up: () => runtime.status(record).find((e) => e.env === env && e.commitOid === oid),
    start: () => previewBuild(app, actor, repo, oid),
  };
}

/** How long a build gets to come up before the capture gives up. */
const WAIT_MS = 15 * 60_000;
/** The picture's window: a game's wide screen, which the cover crops to its middle square. */
const ART_WINDOW = { width: 960, height: 624 } as const;

/**
 * Capture one page of `oid`: start its build preview as `actor` if it is
 * not running, wait for it, save the page once and picture it. Resolves
 * when done; `startCapture` is the same, in the background.
 */
export async function captureCart(
  app: App,
  actor: User | undefined,
  repo: Repo,
  oid: string,
  page: string,
  options: CaptureOptions = {},
): Promise<Result<void, CaptureError>> {
  if (!valid(oid, page)) return err("invalid");
  const base = capturePath(app.config.dataDir, repo, oid, page);
  if (existsSync(`${base}.html`)) return ok(undefined);
  const build = options.build ?? previewOf(app, actor, repo, oid);
  if (build === undefined) return err("not_an_app");
  if (build.up()?.state !== "running") {
    const started = await build.start();
    if (!started.ok) return started;
  }
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  let port: number | undefined;
  for (;;) {
    const now = build.up();
    if (now?.state === "running" && now.port !== undefined) {
      port = now.port;
      break;
    }
    if (now?.state === "failed") return err("build_failed");
    if (Date.now() > deadline) return err("timed_out");
    await Bun.sleep(options.pollMs ?? 500);
  }
  return keepPage(base, `http://127.0.0.1:${port}${page}`, options.picture ?? takeLook, `${repo.ownerName}/${repo.name}`, oid, page);
}

/** The most bytes of a build's page a capture keeps. */
export const PAGE_MAX = 16 * 1024 * 1024;

/** A response body read up to `max` bytes; undefined if it is longer. */
async function readCapped(answer: Response, max: number): Promise<Uint8Array | undefined> {
  const declared = Number(answer.headers.get("content-length") ?? 0);
  if (declared > max || answer.body === null) return declared > max ? undefined : new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > max) {
      await answer.body.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch `url` once, keep it at `base.html` only if nothing is there, then
 * picture it for the cover's art. A page over `max` bytes is not kept.
 */
export async function keepPage(
  base: string,
  url: string,
  picture: Capture,
  who = "",
  oid = "",
  page = "",
  max = PAGE_MAX,
): Promise<Result<void, "page_missing">> {
  let bytes: Uint8Array | undefined;
  try {
    const answer = await fetch(url, { redirect: "manual" });
    if (!answer.ok) return err("page_missing");
    bytes = await readCapped(answer, max);
  } catch {
    return err("page_missing");
  }
  if (bytes === undefined) return err("page_missing");
  writeOnce(`${base}.html`, bytes);
  // The picture is the cover's art; a cart without one still plays.
  const staged = `${base}.${process.pid}.shot.png`;
  const shot = await picture({ url, out: staged, ...ART_WINDOW, timeoutMs: 30_000 });
  if (shot.ok && existsSync(staged)) writeOnce(`${base}.png`, new Uint8Array(readFileSync(staged)));
  else if (!shot.ok) log.warn("cart picture not taken", { repo: who, oid, page, error: shot.error });
  rmSync(staged, { force: true });
  return ok(undefined);
}

/** A failed build's first error line, from its environment, so a person reads why. */
function failedDetail(app: App, repo: Repo, oid: string, error: CaptureError): { detail?: string } {
  if (error !== "build_failed") return {};
  const record = getAppByRepo(app.db, repo.id);
  const env = record === undefined ? undefined : appsRuntime(app)?.status(record).find((e) => e.env === buildEnv(oid));
  const first = env?.error?.split("\n")[0]?.trim();
  return first === undefined || first === "" ? {} : { detail: first };
}

/** Capture in the background; the panel reads `captureState` meanwhile. */
export function startCapture(
  app: App,
  actor: User | undefined,
  repo: Repo,
  oid: string,
  page: string,
  options: CaptureOptions = {},
): Promise<Result<void, CaptureError>> {
  const map = jobsOf(app);
  const key = jobKey(repo, oid, page);
  map.set(key, { state: "capturing" });
  return captureCart(app, actor, repo, oid, page, options).then(
    (done) => {
      if (done.ok) map.delete(key);
      else map.set(key, { state: "failed", error: done.error, ...failedDetail(app, repo, oid, done.error) });
      return done;
    },
    (error: unknown) => {
      log.error("cart capture failed", { oid, page, error: String(error) });
      map.set(key, { state: "failed", error: "page_missing" });
      return err("page_missing" as const);
    },
  );
}
