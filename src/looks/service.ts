/**
 * The look (docs/APPS.md): when an environment's deploy answers and swaps
 * in, the forge takes a picture of it at phone and desktop width, as the
 * repository's owner would see it, and keeps the pictures beside the
 * commit they are of. A person judges a change from what it is — the
 * moment it starts serving, not the moment its tests, still running
 * beside it, happen to finish (and a preview whose tests then fail keeps
 * the picture it already has).
 *
 * Best-effort by design: a look never blocks a check, never fails a run,
 * and a picture that could not be taken is a row that says why, so a page
 * can say "no picture" honestly. One look per environment and head; a
 * newer head replaces one still waiting; one waiting too long is dropped
 * rather than pictured late. Pictures live exactly as long as the
 * environment does — a preview's go when its pull closes.
 */

import { sealedPreview } from "../core/sealed.ts";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "../app.ts";
import { envBuild, envPull, isEnvName, previewEnv, type EnvName } from "../apps/data.ts";
import { plainProof, signGrant, type GrantWho } from "../apps/proxy.ts";
import { appsRuntime } from "../apps/runtime.ts";
import {
  getAppById,
  getAppByRepo,
  listApps,
  type AppRecord,
} from "../core/apps.ts";
import type { ForgeEvent } from "../core/events.ts";
import {
  deleteLooks,
  deleteStrangerThumbs,
  DEFAULT_PAGE,
  LEGACY_THUMB_WIDTH,
  DARK_KINDS,
  DEFAULT_THEME,
  LOOK_KINDS,
  LOOK_THEMES,
  type LookTheme,
  LOOK_SIZES,
  LOOK_WINDOWS,
  lookSlot,
  looksForEnv,
  recordLook,
  type Look,
  type LookKind,
} from "../core/looks.ts";
import { crewHoldsCore, forgeCpus } from "../core/one_core.ts";
import { getPull } from "../core/pulls.ts";
import { listActive } from "../core/runs.ts";
import { frontPicks } from "../core/front.ts";
import { getRepoById } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { ownerLooksFor, PREVIEW_NEWCOMER } from "../spawn/preview-looks.ts";
import { thumbnail } from "../design/image/image.ts";
import { decodePng, encodePng, pngHeader } from "../design/image/png.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { addCommitLook } from "../checks/looks.ts";
import type { LookVitals } from "../checks/summary.ts";
import { keepAsMain } from "./main_looks.ts";
import { findChromium, isNoBrowser, takeLook, type Capture } from "./capture.ts";
import { backoff, type BackoffClock } from "./backoff.ts";
import { during } from "../perf/jobs.ts";

const log = createLog("looks");

export interface LooksOptions {
  /** The forge's own listener, plain http: where the browser is pointed. */
  readonly localUrl: string;
  /** What takes the picture. Chromium unless a test says otherwise. */
  readonly capture?: Capture | undefined;
  /**
   * How full the process's memory is, 0 to 1, or undefined when unknown.
   * The container's cgroup unless a test says otherwise. A browser is the
   * one thing here that can tip a pod over its limit, so a look waits
   * while two agent runs are at their peak rather than being the straw.
   */
  readonly pressure?: (() => number | undefined) | undefined;
  /** The clock a failed look's backoff waits on: the real one unless a test says otherwise. */
  readonly clock?: BackoffClock | undefined;
  /**
   * Whether the app answers at its port now: a real request unless a test
   * says otherwise. A look waits for this before opening a browser (#11520).
   */
  readonly answers?: ((port: number) => Promise<boolean>) | undefined;
  /** How long a look waits for the app to answer, and how often it asks. */
  readonly answerWaitMs?: number | undefined;
  readonly answerPollMs?: number | undefined;
  /** The forge's CPU count: the machine's unless a test says otherwise. */
  readonly cpus?: (() => number) | undefined;
  /** Crew runs queued or running: the database's unless a test says otherwise. */
  readonly activeCrewRuns?: (() => number) | undefined;
}

/** The app answers when its page comes back with anything but a server error. */
async function appAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/** What a look records when the app never answered, so no browser was opened. */
export const NOT_ANSWERING = "the app did not answer its health check in time";

/** The share of the memory limit in use, read from cgroup v2, if this is a container. */
export function cgroupMemoryPressure(): number | undefined {
  try {
    const read = (name: string): string =>
      readFileSync(`/sys/fs/cgroup/${name}`, "utf8");
    let stat = "";
    try {
      stat = read("memory.stat");
    } catch {
      // A cgroup without the breakdown: the total will have to do.
    }
    return memoryPressure(stat, read("memory.max"), read("memory.current"));
  } catch {
    return undefined;
  }
}

/**
 * The share of the limit the container truly holds. `memory.current`
 * counts the page cache too — every git object and database page read
 * lately, which the kernel hands back the moment anyone needs it — and a
 * forge that reads its repositories all day sits above any ceiling by that
 * number for good. The anonymous pages are what would have to give.
 */
export function memoryPressure(
  stat: string,
  max: string,
  current: string,
): number | undefined {
  if (max.trim() === "max") return undefined;
  const limit = Number(max);
  if (!(limit > 0)) return undefined;
  const anon = /^anon (\d+)$/m.exec(stat);
  const used = anon === null ? Number(current) : Number(anon[1]);
  return Number.isFinite(used) ? used / limit : undefined;
}

/** Above this share of the limit, a look waits. */
const PRESSURE_CEILING = 0.7;

export interface LooksHandle {
  /** Settles once every look queued so far is taken or dropped. */
  idle(): Promise<void>;
  /** Check production for a missing picture now, as the timer does. */
  sweep(): void;
  stop(): Promise<void>;
}

/** A look that has waited longer than this is stale, and is dropped. */
const MAX_WAIT_MS = 10 * 60_000;
/** How often production is checked for a picture it lacks. */
const SWEEP_MS = 10 * 60_000;
/** The first check, once a booted forge's apps have had a moment. */
const FIRST_SWEEP_MS = 60_000;
/** The browser's whole allowance for one picture. */
const CAPTURE_TIMEOUT_MS = 20_000;
/** How long a look waits for the app to answer before its first picture. */
const ANSWER_WAIT_MS = 5_000;
const ANSWER_POLL_MS = 250;
/** How long the grant in the URL is good for — the browser uses it at once. */
const GRANT_TTL_MS = 60_000;
/**
 * After a picture fails, the whole look waits this long before the next
 * try, and gives up after the last (#11509): an app that is not answering
 * must not have a browser opened on it every second.
 */
export const LOOK_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

export const looksRoot = (dataDir: string): string => join(dataDir, "looks");

/** Where a picture is written while it is being taken. */
const STAGING = ".taking";
const stagingRoot = (dataDir: string): string =>
  join(looksRoot(dataDir), STAGING);

/** Where a picture lives, relative to the data directory. */
export const lookPath = (
  appId: string,
  env: EnvName,
  commitOid: string,
  page: string,
  kind: LookKind,
  theme: LookTheme = DEFAULT_THEME,
): string =>
  join("looks", appId, env, `${commitOid}-${lookSlot(page, kind, theme)}.png`);

/**
 * Whether a picture on record is one to keep. Every one is, except a
 * thumb from before thumbs were the page reduced (`LEGACY_THUMB_WIDTH`):
 * that one is retaken, and shown until it is.
 */
export function keepLook(dataDir: string, look: Look): boolean {
  if (look.error !== null) return false;
  if (look.kind !== "thumb") return true;
  let fd: number | undefined;
  try {
    fd = openSync(join(dataDir, look.path), "r");
    const head = new Uint8Array(33);
    readSync(fd, head, 0, 33, 0);
    const parsed = pngHeader(head);
    return !parsed.ok || parsed.value.width !== LEGACY_THUMB_WIDTH;
  } catch {
    // No file behind the row: nothing to show, so nothing to keep.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A desktop picture reduced to a thumb, in place. */
export function reduceToThumb(path: string): Result<void, string> {
  const decoded = decodePng(new Uint8Array(readFileSync(path)));
  if (!decoded.ok) return err(`the picture could not be read: ${decoded.error}`);
  const { width, height, rgba } = decoded.value;
  const size = LOOK_SIZES.thumb;
  const small = thumbnail(rgba, width, height, size.width, size.height);
  writeFileSync(path, encodePng(small.width, small.height, small.rgba));
  return ok();
}

interface Pending {
  readonly appId: string;
  readonly env: EnvName;
  readonly commitOid: string;
  readonly at: number;
  /** Queued by the sweep: a picture that failed at this head is not retaken. */
  readonly swept?: true;
}

/**
 * What the browser opens: the app's grant door on the forge's own plain-http
 * listener. The `plain` proof tells the door this is that browser, which
 * would drop a `Secure` cookie on http, so a forge whose public address is
 * https still hands it a cookie it keeps (#11519).
 */
export function lookUrl(
  dataDir: string,
  host: string,
  port: string,
  token: string,
  page: string,
): string {
  return `http://${host}:${port}/__forge/grant?t=${encodeURIComponent(token)}&plain=${plainProof(dataDir, token)}&to=${encodeURIComponent(page)}`;
}

export function startLooks(app: App, options: LooksOptions): LooksHandle {
  const { dataDir } = app.config;
  const port = new URL(options.localUrl).port;
  const capture = options.capture ?? takeLook;
  if (options.capture === undefined && findChromium() === undefined)
    log.warn(
      "no chromium on this forge: looks will say so instead of a picture (install one, or set FORGE_CHROMIUM)",
    );
  const queue: Pending[] = [];
  let pump: Promise<void> = Promise.resolve();
  let pumping = false;
  let stopped = false;
  /** Failed looks by app, environment and head: each waits out its backoff (#11509). */
  const failures = backoff(LOOK_BACKOFF_MS, options.clock);
  const failKey = (q: { appId: string; env: EnvName; commitOid: string }): string =>
    `${q.appId}/${q.env}/${q.commitOid}`;

  /** A look failed: try again after the next backoff, or give up with one line. */
  function failed(item: Pending): void {
    const verdict = failures.failed(failKey(item), () => {
      if (!stopped) enqueue({ ...item, at: Date.now() });
    });
    if (!verdict.retry)
      log.warn("look given up: the picture failed every time", {
        app: item.appId,
        env: item.env,
        tries: verdict.tries,
      });
  }

  prune();
  // Production missing a picture at its head — one never taken, or a
  // thumb from before thumbs were the page — gets one while it is up.
  // A woken app says nothing on the bus, so this is how it is pictured.
  const firstSweep = setTimeout(() => during("looks", sweep), FIRST_SWEEP_MS);
  const sweeping = setInterval(() => during("looks", sweep), SWEEP_MS);
  firstSweep.unref?.();
  sweeping.unref?.();

  const unsubscribe = app.bus.subscribe((event: ForgeEvent) => {
    try {
      onEvent(event);
    } catch (error) {
      log.error("looks event handler failed", {
        kind: event.kind,
        error: String(error),
      });
    }
  });

  function onEvent(event: ForgeEvent): void {
    if (stopped || event.repoId === null) return;
    const payload = event.payload;
    switch (event.kind) {
      // The instant a deploy answers and swaps in — the look is of what
      // is serving, not of whether its tests, still running beside it,
      // turn out green.
      case "app.serving": {
        const env = payload["env"];
        const commitOid = payload["commitOid"];
        if (typeof env !== "string" || !isEnvName(env)) return;
        if (typeof commitOid !== "string" || commitOid === "") return;
        const record = getAppByRepo(app.db, event.repoId);
        if (!record) return;
        enqueue({ appId: record.id, env, commitOid, at: Date.now() });
        return;
      }
      // Kept for an environment brought up by a forge from before this
      // event existed: its deploy never published `app.serving`, so this
      // is the only signal it has. For one deployed since, `app.serving`
      // already queued the same commit — `enqueue` below dedupes it.
      case "run.finished": {
        if (payload["kind"] !== "deploy" || payload["state"] !== "ok") return;
        const env = payload["env"];
        const commitOid = payload["commitOid"];
        if (typeof env !== "string" || !isEnvName(env)) return;
        if (typeof commitOid !== "string" || commitOid === "") return;
        const record = getAppByRepo(app.db, event.repoId);
        if (!record) return;
        enqueue({ appId: record.id, env, commitOid, at: Date.now() });
        return;
      }
      case "pull.closed":
      case "pull.merged": {
        const number = payload["number"];
        const record = getAppByRepo(app.db, event.repoId);
        if (typeof number !== "number" || !record) return;
        // Landed: its head's looks become main's before the sweep.
        if (event.kind === "pull.merged") {
          try {
            keepAsMain(app.db, dataDir, record.id, previewEnv(number));
          } catch (error) {
            log.warn("main's looks not kept", { error: String(error) });
          }
        }
        forget(record.id, previewEnv(number));
        return;
      }
      default:
        return;
    }
  }

  /**
   * One waiting look per environment: a newer head takes the older's
   * place. The same head queued twice — `app.serving` and then
   * `run.finished` for the one deploy — is one entry, not two.
   */
  function enqueue(item: Pending): void {
    // A head whose picture failed waits out its backoff: an event for it
    // (a deploy announced twice, a sweep) is not a reason to try sooner.
    if (failures.waiting(failKey(item))) return;
    const at = queue.findIndex(
      (q) => q.appId === item.appId && q.env === item.env,
    );
    if (at !== -1) {
      if (queue[at]!.commitOid === item.commitOid) return;
      queue.splice(at, 1);
    }
    queue.push(item);
    kick();
  }

  function kick(): void {
    if (pumping || stopped || queue.length === 0) return;
    pumping = true;
    pump = drain().finally(() => {
      pumping = false;
    });
  }

  async function drain(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (next === undefined || stopped) return;
      // One core: a crew run has it. The look keeps its place and the next
      // sweep takes it once the run has ended (src/core/one_core.ts).
      const cpus = options.cpus ?? forgeCpus;
      const active =
        options.activeCrewRuns ?? (() => listActive(app.db, "agent").length);
      if (crewHoldsCore(cpus(), active())) {
        queue.unshift(next);
        return;
      }
      if (Date.now() - next.at > MAX_WAIT_MS) {
        log.warn("look dropped: waited too long", {
          app: next.appId,
          env: next.env,
        });
        continue;
      }
      // Memory first: a capture behind two agent runs at their peak waits
      // its turn, and gives up with the rest of the queue's patience.
      const pressure = options.pressure ?? cgroupMemoryPressure;
      if ((pressure() ?? 0) > PRESSURE_CEILING) {
        if (stopped) return;
        queue.unshift(next);
        await Bun.sleep(15_000);
        continue;
      }
      try {
        await take(next);
      } catch (error) {
        log.error("look failed", {
          app: next.appId,
          env: next.env,
          error: String(error),
        });
      }
    }
  }

  /** Ask until the app answers or the wait is spent. */
  async function answered(port: number): Promise<boolean> {
    const ask = options.answers ?? appAnswers;
    const waitMs = options.answerWaitMs ?? ANSWER_WAIT_MS;
    const pollMs = options.answerPollMs ?? ANSWER_POLL_MS;
    const until = Date.now() + waitMs;
    for (;;) {
      if (await ask(port)) return true;
      if (stopped || Date.now() >= until) return false;
      await Bun.sleep(pollMs);
    }
  }

  async function take(item: Pending): Promise<void> {
    const record = getAppById(app.db, item.appId);
    const runtime = appsRuntime(app);
    if (!record || runtime === undefined) return;
    const repo = getRepoById(app.db, record.repoId);
    if (!repo) return;
    // The environment must still be serving this commit: a look of a
    // page that has moved on would be filed under the wrong head.
    const status = runtime.envStatus(record, item.env);
    if (status?.state !== "running" || status.commitOid !== item.commitOid)
      return;
    // A preview of the forge itself always takes its named owner looks
    // (`spawn/preview-looks.ts`), whatever its forge.json lists (#8974).
    const ownerLooks = ownerLooksFor(app.config.forgeRepo, repo, item.env);
    const pages = [
      ...new Set([
        ...(status.looks ?? [DEFAULT_PAGE]),
        ...ownerLooks.map((l) => l.page),
      ]),
    ];
    const wanted = missing(
      item.appId,
      item.env,
      item.commitOid,
      pages,
      item.swept === true,
    );
    if (wanted.length === 0) return;
    // An app still warming up gets no browser: wait, bounded, until it
    // answers; one that never does is recorded as not answering (#11520).
    if (status.port !== undefined && !(await answered(status.port))) {
      if (stopped) return;
      log.warn("no picture: the app did not answer", { app: record.slug, env: item.env });
      for (const { page, kind, theme } of wanted)
        recordLook(app.db, {
          appId: item.appId,
          env: item.env,
          commitOid: item.commitOid,
          page,
          theme,
          kind,
          path: "",
          error: NOT_ANSWERING,
        });
      failed(item);
      return;
    }
    // The phone and desktop pictures are what the owner sees: the app
    // renders for a signed-in admin, exactly as when they open it from the
    // forge. The thumb is what a stranger sees — it is the picture on the
    // tiles a signed-out visitor is shown — so it is taken as nobody. A
    // public app on a public repository is the world's to see, so all of
    // its pictures are taken as nobody, and a reader of its pulls sees them
    // too (#738).
    // A sealed pull's preview is its report's (`core/sealed.ts`): nobody can
    // open it, so every picture of it is taken as the owner, and kept for
    // the writers.
    const sealed = sealedPreview(app.db, repo.id, item.env);
    const everyone =
      !sealed && repo.visibility === "public" && record.access === "public";
    // A private app turns a signed-out visitor away to sign in, on another
    // host: its thumb is taken through the grant door as the owner, like
    // its other pictures, and never leaves the app's host (#7830).
    // A page the manifest names in `app.looksAsOwner` shows a stranger
    // nothing worth a picture — an admin's own page — so its phone and
    // desktop are the owner's, and stay the writers', even of a public app
    // (#8812). Its thumb is still what a stranger sees.
    const ownerPages = new Set(status.looksAsOwner ?? []);
    const asNobody = (kind: LookKind, page: string): boolean =>
      !sealed &&
      !(kind !== "thumb" && ownerPages.has(page)) &&
      !ownerLooks.some((l) => l.page === page && l.kind === kind) &&
      (everyone || (kind === "thumb" && record.access === "public"));
    const owner = getUserById(app.db, repo.ownerId);
    const asOwner: GrantWho | undefined =
      owner === undefined
        ? undefined
        : { id: owner.id, name: owner.username, role: "admin" };
    const host = runtime.hostFor(record.slug, item.env);
    const newcomer: GrantWho = { id: PREVIEW_NEWCOMER, name: PREVIEW_NEWCOMER, role: "admin" };
    const isNewcomerLook = (page: string): boolean =>
      ownerLooks.some((l) => l.page === page && l.as === "newcomer");
    let allOk = true;
    let failedHere = false;
    let verdict: string | undefined;
    for (const { page, kind, theme } of wanted) {
      if (stopped) return;
      if (verdict !== undefined) {
        recordLook(app.db, {
          appId: item.appId,
          env: item.env,
          commitOid: item.commitOid,
          page,
          theme,
          kind,
          path: "",
          error: verdict,
        });
        continue;
      }
      const token = signGrant(
        dataDir,
        { app: record, env: item.env },
        GRANT_TTL_MS,
        Date.now(),
        asNobody(kind, page) ? undefined : isNewcomerLook(page) ? newcomer : asOwner,
      );
      const url = lookUrl(dataDir, host, port, token, page);
      const path = lookPath(item.appId, item.env, item.commitOid, page, kind, theme);
      const out = join(dataDir, path);
      // Taken to one side and moved in whole. A pull that closes while its
      // picture is being taken sweeps its environment's folder away, and a
      // browser told to write into a folder that is gone has no picture to
      // give; this way the sweep and the picture never meet.
      const staged = join(
        stagingRoot(dataDir),
        `${item.appId}-${item.env}-${item.commitOid}-${lookSlot(page, kind, theme)}.png`,
      );
      mkdirSync(dirname(staged), { recursive: true });
      const shot = await capture({
        url,
        out: staged,
        ...LOOK_WINDOWS[kind],
        ...(theme === "dark" ? { dark: true } : {}),
        timeoutMs: CAPTURE_TIMEOUT_MS,
      });
      // The thumb is the desktop page again, as a stranger: it adds no row.
      // What the page recorded is filed under the commit at once, for the
      // check summary's vitals table: a round that ends early keeps it.
      if (kind !== "thumb" && theme === "light") {
        const look = page === "/" ? kind : `${kind} ${page}`;
        const filed: LookVitals | undefined = shot.ok
          ? { look, entries: shot.value.entries, ...(shot.value.size === undefined ? {} : { size: shot.value.size }) }
          : isNoBrowser(shot.error)
            ? { look, skipped: "no browser" }
            : undefined;
        if (filed !== undefined) {
          try {
            addCommitLook(dataDir, record.repoId, item.commitOid, filed);
          } catch (error) {
            log.warn("vitals not recorded", { commit: item.commitOid, error: String(error) });
          }
        }
      }
      const taken =
        shot.ok && kind === "thumb" ? reduceToThumb(staged) : shot;
      const row = {
        appId: item.appId,
        env: item.env,
        commitOid: item.commitOid,
        page,
        theme,
      };
      if (taken.ok) {
        // The environment moved on while the picture was taken: it shows
        // a page nobody serves now, and goes the way of its folder.
        const still = runtime.envStatus(record, item.env);
        if (
          stopped ||
          still?.state !== "running" ||
          still.commitOid !== item.commitOid
        ) {
          rmSync(staged, { force: true });
          return;
        }
        mkdirSync(dirname(out), { recursive: true });
        renameSync(staged, out);
        recordLook(app.db, {
          ...row,
          kind,
          path,
          takenAs: asNobody(kind, page) ? "nobody" : "owner",
          ...(shot.ok && shot.value.size !== undefined ? { size: shot.value.size } : {}),
        });
      } else {
        rmSync(staged, { force: true });
        allOk = false;
        const noBrowser = isNoBrowser(taken.error);
        failedHere = failedHere || !noBrowser;
        log.warn("no picture", {
          app: record.slug,
          env: item.env,
          page,
          kind,
          theme,
          error: taken.error,
        });
        recordLook(app.db, { ...row, kind, path: "", error: taken.error });
        // One failure is the verdict for this try: the other pictures
        // would meet the same page, so they are filed with its reason
        // and no browser is opened for them.
        if (!noBrowser) verdict = taken.error;
      }
    }
    if (failedHere) failed(item);
    else failures.succeeded(failKey(item));
    // A full set at this head is the environment's look now; the pictures
    // of heads before it have nothing left to say.
    if (allOk)
      remove(deleteLooks(app.db, item.appId, item.env, item.commitOid));
    if (allOk)
      app.bus.append({
        kind: "look.taken",
        repoId: record.repoId,
        payload: { env: item.env, commitOid: item.commitOid },
      });
  }

  /**
   * The pictures one head still wants: every page at every kind, less
   * those on record to keep — and, when `failedCounts`, less those that
   * failed too.
   */
  function missing(
    appId: string,
    env: EnvName,
    commitOid: string,
    pages: readonly string[] | undefined,
    failedCounts = false,
  ): { page: string; kind: LookKind; theme: LookTheme }[] {
    const have = new Set(
      looksForEnv(app.db, appId, env, "any")
        .filter(
          (l) =>
            l.commitOid === commitOid &&
            (keepLook(dataDir, l) || (failedCounts && l.error !== null)),
        )
        .map((l) => lookSlot(l.page, l.kind, l.theme)),
    );
    return (pages ?? [DEFAULT_PAGE]).flatMap((page) =>
      LOOK_THEMES.flatMap((theme) =>
        LOOK_KINDS.filter(
          (kind) =>
            (theme === "light" || DARK_KINDS.includes(kind)) &&
            !have.has(lookSlot(page, kind, theme)),
        ).map((kind) => ({ page, kind, theme })),
      ),
    );
  }

  /** Queue every running production whose head lacks a picture to keep. */
  function sweep(): void {
    if (stopped) return;
    kick();
    const runtime = appsRuntime(app);
    if (runtime === undefined) return;
    try {
      const pinned = new Set(frontPicks(app.db).pinned);
      const toWake: AppRecord[] = [];
      for (const record of listApps(app.db)) {
        const status = runtime.envStatus(record, "production");
        // An app pinned to the front page is shown only with a picture, so
        // one asleep without one is woken to have it taken — at most the
        // dozen pins, and only those a stranger can open.
        if (
          status?.state === "asleep" &&
          pinned.has(record.repoId) &&
          record.access === "public" &&
          getRepoById(app.db, record.repoId)?.visibility === "public" &&
          missing(record.id, "production", status.commitOid, status.looks, true)
            .length > 0
        )
          toWake.push(record);
        if (status?.state !== "running") continue;
        // A picture that failed at this head had its turn: the next
        // deploy tries again, not every sweep.
        const { commitOid, looks: pages } = status;
        if (missing(record.id, "production", commitOid, pages, true).length > 0)
          enqueue({
            appId: record.id,
            env: "production",
            commitOid,
            at: Date.now(),
            swept: true,
          });
      }
      if (toWake.length > 0) void wakeForPictures(runtime, toWake);
    } catch (error) {
      log.error("looks sweep failed", { error: String(error) });
    }
  }

  /** Wake each app in turn and queue its picture; it sleeps again on its own. */
  async function wakeForPictures(
    runtime: NonNullable<ReturnType<typeof appsRuntime>>,
    records: readonly AppRecord[],
  ): Promise<void> {
    for (const record of records) {
      if (stopped) return;
      try {
        const live = await runtime.wake(record, "production");
        if (live === undefined) continue;
        enqueue({
          appId: record.id,
          env: "production",
          commitOid: live.commitOid,
          at: Date.now(),
          swept: true,
        });
      } catch (error) {
        log.warn("could not wake a pinned app for its picture", {
          app: record.slug,
          error: String(error),
        });
      }
    }
  }

  /** An environment is gone: so are its pictures, waiting or taken. */
  function forget(appId: string, env: EnvName): void {
    failures.forget(`${appId}/${env}/`);
    const at = queue.findIndex((q) => q.appId === appId && q.env === env);
    if (at !== -1) queue.splice(at, 1);
    deleteLooks(app.db, appId, env);
    rmSync(join(looksRoot(dataDir), appId, env), {
      recursive: true,
      force: true,
    });
  }

  function remove(looks: readonly { path: string }[]): void {
    for (const look of looks)
      if (look.path !== "") rmSync(join(dataDir, look.path), { force: true });
  }

  /**
   * Before #7830 a private app's thumb was taken as a signed-out visitor,
   * who is sent to sign in on another host: its picture is a certificate
   * warning. Those thumbs are deleted, and the sweep takes them again as
   * the owner. Returns how many went.
   */
  function retakeStrangerThumbs(record: AppRecord): number {
    if (record.access === "public") return 0;
    const bad = deleteStrangerThumbs(app.db, record.id);
    if (bad.length === 0) return 0;
    remove(bad);
    log.info("thumbs of a private app taken as a stranger, to be retaken", {
      app: record.slug,
      count: bad.length,
    });
    return bad.length;
  }

  /**
   * Pictures on disk for apps that no longer exist, or previews whose pull
   * closed while no forge was listening, are nobody's: the same sweep the
   * runtime makes over its checkouts on boot.
   */
  function prune(): void {
    const root = looksRoot(dataDir);
    if (!existsSync(root)) return;
    const known = new Map(listApps(app.db).map((r) => [r.id, r]));
    for (const appId of readdirSync(root)) {
      // Half-taken pictures of a forge that stopped mid-shot.
      if (appId === STAGING) {
        rmSync(join(root, appId), { recursive: true, force: true });
        continue;
      }
      const record = known.get(appId);
      if (record === undefined) {
        rmSync(join(root, appId), { recursive: true, force: true });
        continue;
      }
      retakeStrangerThumbs(record);
      for (const env of readdirSync(join(root, appId))) {
        if (!isEnvName(env)) continue;
        // A build preview is gone once the runtime no longer holds it.
        if (envBuild(env) !== undefined) {
          if (appsRuntime(app)?.envStatus(record, env) === undefined)
            forget(appId, env);
          continue;
        }
        if (envPull(env) === undefined) continue;
        const pull = getPull(app.db, record.repoId, Number(env.slice(5)));
        if (
          pull === undefined ||
          pull.state !== "open" ||
          pull.mergedAt !== null
        )
          forget(appId, env);
      }
    }
  }

  return {
    idle: () => pump,
    sweep,
    stop: async () => {
      stopped = true;
      clearTimeout(firstSweep);
      clearInterval(sweeping);
      failures.stop();
      unsubscribe();
      queue.length = 0;
      await pump;
    },
  };
}
