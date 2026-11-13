/**
 * The stranger's journey, walked against a live forge (#11158, part 2): from
 * the forge's home to a crew visibly at work, the way a person with a browser
 * goes — the same requests `test/stranger-three-screens.test.ts` follows by hand.
 *
 *   1. open `/`                       (screen 1)
 *   2. name a throwaway forge         POST /forges/start, then wait on /forges/<name>/ready
 *   3. choose a username + password   the new forge's /claim   (screen 2)
 *   4. land in the forge              (screen 3)
 *   5. say one tiny thing to build    POST /tell on the new forge
 *   6. poll the forge's home until the crew's activity shows
 *
 * Plain data in, plain data out; nothing here throws for a step that went
 * wrong — the step is named in `failure`. The budgets are `FIRST_FIVE_MINUTES`.
 * Every request has a timeout, and no text of the caller's reaches a shell:
 * there is no shell here, only `fetch`.
 *
 * The throwaway forge is removed afterwards, passed or failed: its crew run is
 * cancelled first (best effort: the forge's removal stops the whole child and
 * everything in it), then `POST /forges/<name>/remove` on the host with
 * `adminToken` — the one thing the host asks an admin for. Without a token the
 * forge cannot be removed from here, and `removed` says so; the walk's verdict
 * is its own.
 */
import { FIRST_FIVE_MINUTES } from "../design/first_five_minutes.ts";

export interface JourneyOptions {
  /** The live forge's address, http(s). */
  readonly base: string;
  /** How to reach it; `fetch` when left out. A test hands in one that knows where the new forge's host is. */
  readonly fetch?: typeof fetch;
  /** The tiny thing to ask the crew to build. */
  readonly ask?: string;
  /** Milliseconds, monotonic enough to subtract; `Date.now` when left out. */
  readonly now?: () => number;
  /** A site admin's token on the host: removes the throwaway forge afterwards. */
  readonly adminToken?: string;
  /** Pause between polls, in ms (default 500); how a test keeps its clock quick. */
  readonly pollMs?: number;
  /** Waits `ms`; `Bun.sleep` when left out. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface JourneyResult {
  readonly ok: boolean;
  /** The screens a person was shown, in order, the forge last. */
  readonly screens: readonly string[];
  /** From naming the forge to its answering, in ms; null when it never did. */
  readonly readyMs: number | null;
  /** From the ask to the crew's activity on the forge's home, in ms; null when none showed. */
  readonly firstActivityMs: number | null;
  /** The step that failed, in words. */
  readonly failure?: string;
  /** The throwaway forge's name; null when none was made. */
  readonly forge: string | null;
  /** Whether the throwaway forge was removed afterwards (true when none was made). */
  readonly removed: boolean;
}

/** The longest any one request may take. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** The tiny ask: small enough that a probe spends no more than the first activity. */
export const PROBE_ASK = "A page that says hello";

/** What a forge's home says once the crew has begun on an ask (`appCrew` in `src/core/app-crew.ts`). */
const ACTIVITY = /\b(?:is working toward|is about to start on)\b/;

/** A run the app's runs page links to: the crew has been given the ask. */
const RUN_LINK = /href="\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/runs\/[A-Za-z0-9_-]+"/;

/** A name that is free to be made and removed: `probe-` and eight hex digits. */
const probeName = (): string => `probe-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

class Step extends Error {}

/** Walks the journey against `options.base`; never throws for a step that went wrong. */
export async function walkJourney(options: JourneyOptions): Promise<JourneyResult> {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? globalThis.fetch;
  const pollMs = options.pollMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const screens: string[] = [];
  let forge: string | null = null;
  let readyMs: number | null = null;
  let firstActivityMs: number | null = null;
  let failure: string | undefined;
  let host: URL | undefined;
  let child: URL | undefined;
  let cookie = "";
  let removed = true;

  try {
    host = new URL(options.base);
  } catch {
    return { ok: false, screens, readyMs, firstActivityMs, failure: "the forge's address is not a URL", forge, removed };
  }
  if (host.protocol !== "http:" && host.protocol !== "https:")
    return { ok: false, screens, readyMs, firstActivityMs, failure: "the forge's address is not http or https", forge, removed };
  const hostUrl = host;

  const call = (url: URL, init: RequestInit = {}): Promise<Response> =>
    doFetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
  const form = (url: URL, fields: Record<string, string>, extra: Record<string, string> = {}): Promise<Response> =>
    call(url, {
      method: "POST",
      headers: { origin: url.origin, ...extra },
      body: new URLSearchParams(fields),
    });
  /** Runs one step; a refusal or a network error becomes the words for that step. */
  const step = async <T>(words: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      throw e instanceof Step ? e : new Step(`${words} (${e instanceof Error ? e.name : "failed"})`);
    }
  };
  const expect = (res: Response, words: string, ...statuses: number[]): void => {
    if (!statuses.includes(res.status)) throw new Step(`${words}: it answered ${res.status}`);
  };

  try {
    // 1. The home.
    await step("the forge's home did not open", async () => {
      const res = await call(new URL("/", hostUrl));
      expect(res, "the forge's home did not open", 200);
      await res.text();
      screens.push("home");
    });

    // 2. Name a throwaway forge, as the browser does (js=1: a 303 to the waiting page).
    const name = probeName();
    const t0 = now();
    const claimCode = await step("the forge could not be named", async () => {
      const res = await form(new URL("/forges/start", hostUrl), { name, js: "1" });
      await res.body?.cancel();
      expect(res, "the forge could not be named", 303);
      forge = name;
      const to = res.headers.get("location") ?? "";
      const code = /^\/forges\/[a-z0-9-]+\/waiting#([A-Za-z0-9_-]{43})$/.exec(to)?.[1];
      if (code === undefined) throw new Step(`the forge could not be named: it sent the person somewhere else (${to.slice(0, 40)})`);
      return code;
    });

    // Where it will live: the waiting page names it (never the code).
    const waiting = await step("the waiting page did not open", async () => {
      const res = await call(new URL(`/forges/${name}/waiting`, hostUrl));
      expect(res, "the waiting page did not open", 200);
      return res.text();
    });
    const claimAt = /data-claim="([^"]+)"/.exec(waiting)?.[1]?.replaceAll("&amp;", "&");
    let claim: URL | undefined;
    try {
      claim = claimAt === undefined ? undefined : new URL(claimAt);
    } catch {}
    const lives = (u: URL) => (u.protocol === "http:" || u.protocol === "https:") && (u.hostname.startsWith(`${name}--`) || u.hostname.startsWith(`${name}.`));
    if (claim === undefined || !lives(claim)) throw new Step("the waiting page did not say where the forge is");
    child = new URL("/", claim);
    const childUrl = child;

    // Ready within the budget.
    const readyBudget = FIRST_FIVE_MINUTES.forgeReadySeconds * 1000;
    for (;;) {
      let ready = false;
      try {
        const res = await call(new URL(`/forges/${name}/ready`, hostUrl), { headers: { accept: "application/json" } });
        if (res.status === 200) ready = ((await res.json()) as { ready?: unknown }).ready === true;
        else await res.body?.cancel();
      } catch {}
      if (ready) {
        readyMs = now() - t0;
        break;
      }
      if (now() - t0 >= readyBudget) throw new Step(`the forge was not ready in ${FIRST_FIVE_MINUTES.forgeReadySeconds} s`);
      await sleep(pollMs);
    }

    // 3. The claim form, then a username and a password.
    await step("the account form did not open", async () => {
      const res = await call(new URL("/claim", childUrl));
      expect(res, "the account form did not open", 200);
      await res.text();
      screens.push("account");
    });
    const username = `probe-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const password = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const landing = await step("the account could not be made", async () => {
      const res = await form(new URL("/claim", childUrl), { token: claimCode, username, password });
      await res.body?.cancel();
      expect(res, "the account could not be made", 303);
      cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      if (!cookie.includes("=")) throw new Step("the account could not be made: nobody was signed in");
      return res.headers.get("location") ?? "/";
    });

    // 4. In the forge, signed in.
    await step("the new forge did not open", async () => {
      const res = await call(new URL(landing, childUrl), { headers: { cookie } });
      expect(res, "the new forge did not open", 200);
      await res.text();
      screens.push("forge");
    });
    if (screens.length > FIRST_FIVE_MINUTES.screensBeforeForge)
      throw new Step(`it took ${screens.length} screens, more than ${FIRST_FIVE_MINUTES.screensBeforeForge}`);

    // 5. One tiny ask.
    const asked = now();
    await step("the ask was not taken", async () => {
      const res = await form(new URL("/tell", childUrl), { app: "new-app", text: options.ask ?? PROBE_ASK }, { cookie });
      await res.body?.cancel();
      expect(res, "the ask was not taken", 200, 201, 303);
    });

    // 6. The crew's first activity on the forge's home.
    const activityBudget = FIRST_FIVE_MINUTES.firstCrewActivitySeconds * 1000;
    for (;;) {
      let seen = false;
      try {
        const res = await call(new URL("/", childUrl), { headers: { cookie } });
        if (res.status === 200) {
          const page = await res.text();
          seen = ACTIVITY.test(page);
          // An app the asker owns is not in the home's crew card; its runs page is where its first run shows.
          const app = /<option value="([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)"/.exec(page)?.[1];
          if (!seen && app !== undefined) {
            const runs = await call(new URL(`/${app}/runs`, childUrl), { headers: { cookie } });
            seen = runs.status === 200 && RUN_LINK.test(await runs.text());
          }
        } else if (res.status >= 500) throw new Step(`the forge's home answered ${res.status} while the crew started`);
        else await res.body?.cancel();
      } catch (e) {
        if (e instanceof Step) throw e;
      }
      if (seen) {
        firstActivityMs = now() - asked;
        break;
      }
      if (now() - asked >= activityBudget) throw new Step(`the crew was not at work in ${FIRST_FIVE_MINUTES.firstCrewActivitySeconds} s`);
      await sleep(pollMs);
    }
  } catch (e) {
    failure = e instanceof Step ? e.message : "the walk stopped unexpectedly";
  }

  // Afterwards, passed or failed: stop the crew's run, then remove the forge.
  if (forge !== null) {
    if (child !== undefined && cookie !== "") await cancelRuns(doFetch, child, cookie);
    removed = await removeForge(doFetch, hostUrl, forge, options.adminToken);
  }
  const result = { ok: failure === undefined, screens, readyMs, firstActivityMs, forge, removed };
  return failure === undefined ? result : { ...result, failure };
}

/** Cancels each run the forge's home links to; a miss is never an error (the forge's removal ends them anyway). */
async function cancelRuns(doFetch: typeof fetch, child: URL, cookie: string): Promise<void> {
  try {
    const res = await doFetch(new URL("/", child).href, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const page = res.status === 200 ? await res.text() : "";
    const paths = new Set([...page.matchAll(/href="(\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/runs\/[A-Za-z0-9_-]+)"/g)].map((m) => m[1]!));
    for (const path of [...paths].slice(0, 5)) {
      const url = new URL(`${path}/cancel`, child);
      const out = await doFetch(url.href, { method: "POST", headers: { origin: url.origin, cookie }, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      await out.body?.cancel();
    }
  } catch {}
}

/** Removes the throwaway forge from the host; true when the host said it is gone. */
async function removeForge(doFetch: typeof fetch, host: URL, name: string, token: string | undefined): Promise<boolean> {
  if (token === undefined || token === "") return false;
  try {
    const url = new URL(`/forges/${name}/remove`, host);
    const res = await doFetch(url.href, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { origin: url.origin, authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}
