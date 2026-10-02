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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "../app.ts";
import { isEnvName, previewEnv, type EnvName } from "../apps/data.ts";
import { signGrant, type GrantWho } from "../apps/proxy.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAppById, getAppByRepo, listApps } from "../core/apps.ts";
import type { ForgeEvent } from "../core/events.ts";
import {
  deleteLooks,
  DEFAULT_PAGE,
  LOOK_KINDS,
  LOOK_SIZES,
  lookSlot,
  looksForEnv,
  recordLook,
  type LookKind,
} from "../core/looks.ts";
import { getPull } from "../core/pulls.ts";
import { getRepoById } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";
import { findChromium, takeLook, type Capture } from "./capture.ts";

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
}

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
  stop(): Promise<void>;
}

/** A look that has waited longer than this is stale, and is dropped. */
const MAX_WAIT_MS = 10 * 60_000;
/** The browser's whole allowance for one picture. */
const CAPTURE_TIMEOUT_MS = 20_000;
/** How long the grant in the URL is good for — the browser uses it at once. */
const GRANT_TTL_MS = 60_000;

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
): string =>
  join("looks", appId, env, `${commitOid}-${lookSlot(page, kind)}.png`);

interface Pending {
  readonly appId: string;
  readonly env: EnvName;
  readonly commitOid: string;
  readonly at: number;
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

  prune();

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
    const at = queue.findIndex(
      (q) => q.appId === item.appId && q.env === item.env,
    );
    if (at !== -1) {
      if (queue[at]!.commitOid === item.commitOid) return;
      queue.splice(at, 1);
    }
    queue.push(item);
    if (pumping) return;
    pumping = true;
    pump = drain().finally(() => {
      pumping = false;
    });
  }

  async function drain(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (next === undefined || stopped) return;
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
    const pages = status.looks ?? [DEFAULT_PAGE];
    const have = new Set(
      looksForEnv(app.db, item.appId, item.env)
        .filter((l) => l.commitOid === item.commitOid && l.error === null)
        .map((l) => lookSlot(l.page, l.kind)),
    );
    const wanted = pages.flatMap((page) =>
      LOOK_KINDS.filter((kind) => !have.has(lookSlot(page, kind))).map(
        (kind) => ({ page, kind }),
      ),
    );
    if (wanted.length === 0) return;
    // The picture is what the owner sees: the app renders for a signed-in
    // admin, exactly as when they open it from the forge.
    const owner = getUserById(app.db, repo.ownerId);
    const who: GrantWho | undefined =
      owner === undefined
        ? undefined
        : { id: owner.id, name: owner.username, role: "admin" };
    const host = runtime.hostFor(record.slug, item.env);
    let allOk = true;
    for (const { page, kind } of wanted) {
      if (stopped) return;
      const token = signGrant(
        dataDir,
        { app: record, env: item.env },
        GRANT_TTL_MS,
        Date.now(),
        who,
      );
      const url = `http://${host}:${port}/__forge/grant?t=${encodeURIComponent(token)}&to=${encodeURIComponent(page)}`;
      const path = lookPath(item.appId, item.env, item.commitOid, page, kind);
      const out = join(dataDir, path);
      // Taken to one side and moved in whole. A pull that closes while its
      // picture is being taken sweeps its environment's folder away, and a
      // browser told to write into a folder that is gone has no picture to
      // give; this way the sweep and the picture never meet.
      const staged = join(
        stagingRoot(dataDir),
        `${item.appId}-${item.env}-${item.commitOid}-${lookSlot(page, kind)}.png`,
      );
      mkdirSync(dirname(staged), { recursive: true });
      const taken = await capture({
        url,
        out: staged,
        ...LOOK_SIZES[kind],
        timeoutMs: CAPTURE_TIMEOUT_MS,
      });
      const row = {
        appId: item.appId,
        env: item.env,
        commitOid: item.commitOid,
        page,
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
        recordLook(app.db, { ...row, kind, path });
      } else {
        rmSync(staged, { force: true });
        allOk = false;
        log.warn("no picture", {
          app: record.slug,
          env: item.env,
          page,
          kind,
          error: taken.error,
        });
        recordLook(app.db, { ...row, kind, path: "", error: taken.error });
      }
    }
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

  /** An environment is gone: so are its pictures, waiting or taken. */
  function forget(appId: string, env: EnvName): void {
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
      for (const env of readdirSync(join(root, appId))) {
        if (!isEnvName(env) || env === "production") continue;
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
    stop: async () => {
      stopped = true;
      unsubscribe();
      queue.length = 0;
      await pump;
    },
  };
}
