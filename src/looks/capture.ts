/**
 * Taking a picture of a page. Headless Chromium is spawned pointed at a
 * URL on the forge's own listener with the app's hostname resolved to
 * loopback, so the page is served the way a person would be served it —
 * through the proxy, the grant, and the identity headers — without an edge
 * in the way.
 *
 * The URL is not the page but the app's grant door
 * (`/__forge/grant?t=…&to=/`): that one navigation sets the grant cookie and
 * lands on the page as the person the grant names. The browser starts on
 * `about:blank` with its DevTools port open on loopback (no new process:
 * the one it already launches), a script that observes `largest-contentful-
 * paint`, `layout-shift` and `longtask` is installed to run before any
 * page script, and only then is the grant door opened. After load the
 * entries are read back and the picture is taken, both over that one socket.
 * An entry type the browser lacks is an empty list, never a failure.
 *
 * The DevTools port is open on loopback while this browser holds the grant
 * cookie, so a local process could drive that page. That is accepted: the
 * browser lives for one look (seconds, killed in `finally`), its profile is
 * its own and deleted after, the port is random and written only into that
 * profile, `--remote-allow-origins` admits no web origin, and a local
 * process able to reach loopback can already reach the app through the
 * forge's own listener.
 *
 * The picture is taken once the page has loaded and settled a moment,
 * bounded for a page that never finishes — not after a virtual-time budget:
 * a page that holds an event stream open (the scaffold's live script does)
 * never goes idle, and a budget waits forever for it. What an app draws long
 * after load is not in the picture; what it serves is. The browser is killed
 * when it has given the picture, not asked to leave.
 *
 * One picture at a time, forge-wide: a browser is the heaviest thing this
 * process starts, and a pod that holds two agent runs has room for one.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../apps/process.ts";
import { Gate } from "../git/env.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { Entries } from "../release/webvitals.ts";

export interface LookInput {
  /** The URL to open — the grant door of the app's hostname, on the forge's own port. */
  readonly url: string;
  /** Where the picture goes; whatever is there is replaced. */
  readonly out: string;
  readonly width: number;
  readonly height: number;
  /** Force the page's `prefers-color-scheme` to dark; light (the browser's own) when unset. */
  readonly dark?: boolean | undefined;
  /** A browser that has no picture by then is killed; the look fails. */
  readonly timeoutMs: number;
}

/** What the page recorded while it loaded; a type the browser lacks is an empty list. */
export interface Recorded {
  readonly entries: Entries;
  /** The page's own size, when the page reported all four numbers. */
  readonly size?: PageSize | undefined;
}

/** The document's scroll size and the window's inner size, in CSS pixels. */
export interface PageSize {
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/**
 * What takes the picture: the real browser, or a test's stand-in. One that
 * recorded nothing returns empty entries.
 */
export type Capture = (input: LookInput) => Promise<Result<Recorded, string>>;

/** Why there is no picture and no entries when no browser is found. */
export const NO_BROWSER =
  "no chromium on this forge: install one, or set FORGE_CHROMIUM";

/** Whether a capture's error is the want of a browser, not a browser's failure. */
export const isNoBrowser = (error: string): boolean => error === NO_BROWSER;

/** How long a page gets to load before it is pictured as it stands. */
const LOAD_MS = 3_000;

/** The Chromium binary: `FORGE_CHROMIUM`, else the usual names on `PATH`, else the Mac's own. */
export function findChromium(): string | undefined {
  const named = (process.env["FORGE_CHROMIUM"] ?? "").trim();
  if (named !== "") return named;
  for (const name of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ]) {
    const found = Bun.which(name);
    if (found !== null) return found;
  }
  for (const bundle of [
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ])
    if (existsSync(bundle)) return bundle;
  return undefined;
}

const gate = new Gate(1);

/** Take one picture. Serialised: the second caller waits for the first. */
export async function takeLook(
  input: LookInput,
): Promise<Result<Recorded, string>> {
  const binary = findChromium();
  if (binary === undefined)
    return err(NO_BROWSER);
  const release = await gate.acquire();
  try {
    return await shoot(binary, input);
  } finally {
    release();
  }
}

/** Entries kept per type: a page that shifts a thousand times has said enough. */
const MAX_ENTRIES = 500;

/** How long after load the page gets to settle (the last paint, the last shift). */
const SETTLE_MS = 400;

/** Runs before any page script: collects the entries the summary grades. */
const OBSERVER = `(() => {
  if (window.top !== window) return;
  const v = { lcp: [], layoutShift: [], longtask: [] };
  window.__forgeVitals = v;
  const watch = (type, key, pick) => {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) v[key].push(pick(e));
      }).observe({ type, buffered: true });
    } catch (_) {}
  };
  watch("largest-contentful-paint", "lcp", (e) => ({ startTime: e.startTime, size: e.size }));
  watch("layout-shift", "layoutShift", (e) => ({ startTime: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput }));
  watch("longtask", "longtask", (e) => ({ startTime: e.startTime, duration: e.duration }));
})()`;

/** Read after load, in the one evaluate that already fetches the entries. */
const READ = `JSON.stringify(Object.assign({}, window.__forgeVitals, { size: {
  scrollWidth: document.documentElement.scrollWidth,
  scrollHeight: document.documentElement.scrollHeight,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight } }))`;

const whole = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * What the page said, narrowed to what is safe to keep: plain data in, only
 * finite numbers (and the one boolean) out, each list bounded. Whatever the
 * page wrote is untrusted; a missing or malformed type is an empty list.
 */
export function parseRecorded(raw: unknown): Recorded {
  const rec =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const list = (
    key: string,
    fields: readonly string[],
    required: string,
  ): object[] => {
    const items = rec[key];
    if (!Array.isArray(items)) return [];
    const out: object[] = [];
    for (const item of items.slice(0, MAX_ENTRIES)) {
      if (item === null || typeof item !== "object") continue;
      const from = item as Record<string, unknown>;
      const entry: Record<string, number | boolean> = {};
      for (const f of fields) {
        const v = from[f];
        if (finite(v)) entry[f] = v;
        else if (f === "hadRecentInput" && typeof v === "boolean") entry[f] = v;
      }
      // An entry without its defining number is not an entry.
      if (required in entry) out.push(entry);
    }
    return out;
  };
  const sz = rec["size"];
  const from =
    sz !== null && typeof sz === "object"
      ? (sz as Record<string, unknown>)
      : {};
  const { scrollWidth, scrollHeight, innerWidth, innerHeight } = from;
  const size =
    whole(scrollWidth) && whole(scrollHeight) && whole(innerWidth) && whole(innerHeight)
      ? { scrollWidth, scrollHeight, innerWidth, innerHeight }
      : undefined;
  return {
    ...(size === undefined ? {} : { size }),
    entries: {
      lcp: list("lcp", ["startTime", "size"], "startTime"),
      layoutShift: list("layoutShift", ["startTime", "value", "hadRecentInput"], "value"),
      longtask: list("longtask", ["startTime", "duration"], "startTime"),
    },
  };
}

/**
 * Whether the page the browser ended on is the one asked for: why it is
 * not, or undefined when it is. A browser's own error page (a certificate
 * warning, a refused connection) or a page on another host is never a
 * picture of the app, so the look fails and the last good one stays.
 */
export function refusal(
  host: string,
  navigationError: string | undefined,
  href: string,
): string | undefined {
  if (navigationError !== undefined && navigationError !== "")
    return `${navigationError.slice(0, 100)}: the browser showed an error page instead of the app`;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "the browser ended on a page with no address";
  }
  if (url.protocol === "chrome-error:")
    return "the browser showed an error page instead of the app";
  if (url.hostname !== host)
    return `the page left the app's host for ${url.hostname === "" ? url.protocol : url.hostname}`;
  return undefined;
}

/** The DevTools endpoint Chromium writes into its profile once it listens. */
async function endpoint(
  profile: string,
  stillRunning: () => boolean,
  deadline: number,
): Promise<string | undefined> {
  const file = join(profile, "DevToolsActivePort");
  while (stillRunning() && Date.now() < deadline) {
    try {
      const [port, path] = readFileSync(file, "utf8").split("\n");
      if (/^\d{1,5}$/.test(port ?? "") && (path ?? "").startsWith("/devtools/"))
        return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // Not written yet.
    }
    await Bun.sleep(50);
  }
  return undefined;
}

/** One DevTools message: a reply (`id`) or an event (`method`). */
interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

/** A DevTools connection: commands answered by id, events heard by method. */
class Devtools {
  private next = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Set<(method: string, sessionId: string) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      let msg: Message;
      try {
        msg = JSON.parse(String(event.data)) as Message;
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w?.reject(new Error(String(msg.error.message ?? "failed")));
        else w?.resolve(msg.result ?? {});
      } else if (typeof msg.method === "string")
        for (const l of this.listeners) l(msg.method, msg.sessionId ?? "");
    };
    socket.onclose = () => this.fail(new Error("the browser closed the connection"));
    socket.onerror = () => this.fail(new Error("the browser connection failed"));
  }

  static connect(url: string): Promise<Devtools> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const dt = new Devtools(socket);
      socket.onopen = () => resolve(dt);
      const early = () => reject(new Error("could not reach the browser's DevTools"));
      socket.addEventListener("error", early, { once: true });
    });
  }

  private fail(error: Error): void {
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
  }

  send(
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  /** Resolves when `method` is next heard on `sessionId`. */
  heard(method: string, sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const l = (m: string, s: string) => {
        if (m !== method || s !== sessionId) return;
        this.listeners.delete(l);
        resolve();
      };
      this.listeners.add(l);
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

/** Rejects with `what` when the deadline passes before `work` settles. */
function within<T>(work: Promise<T>, deadline: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(what)),
      Math.max(0, deadline - Date.now()),
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * What runs the browser at the lowest CPU priority, given where `nice` is
 * (or null where there is none): a picture is housekeeping, and must never
 * take the cores an app or the forge's requests need (#11509). Without
 * `nice` the browser runs as it is.
 */
export function lowPriority(nice: string | null): string[] {
  return nice === null ? [] : [nice, "-n", "19"];
}

async function shoot(
  binary: string,
  input: LookInput,
): Promise<Result<Recorded, string>> {
  const host = new URL(input.url).hostname;
  // A profile of its own, gone afterwards: no cookie outlives its picture,
  // and two forges in one process never share a browser's state.
  const profile = mkdtempSync(join(tmpdir(), "forge-look-"));
  rmSync(input.out, { force: true });
  const proc = Bun.spawn(
    [
      ...lowPriority(Bun.which("nice")),
      binary,
      "--headless=new",
      // The forge runs as one unprivileged user with no user namespaces
      // to give; the browser's own sandbox is not on offer here.
      "--no-sandbox",
      "--disable-gpu",
      // Containers give /dev/shm 64 MB; the renderer must not depend on it.
      "--disable-dev-shm-usage",
      // No update checks, no push service, no safe-browsing fetches: the
      // only network this browser needs is the forge's own port.
      "--disable-background-networking",
      "--disable-crash-reporter",
      // The cell's proxy (childEnv carries it) is for the world; this
      // browser only ever visits the forge's own listener, directly.
      "--no-proxy-server",
      "--hide-scrollbars",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      // The app's hostname is the forge's own listener: no DNS, no edge.
      `--host-resolver-rules=MAP ${host} 127.0.0.1`,
      `--window-size=${input.width},${input.height}`,
      "--force-device-scale-factor=1",
      "--js-flags=--max-old-space-size=256",
      // Loopback only, on a port the browser picks and writes down.
      "--remote-debugging-port=0",
      "--remote-allow-origins=http://127.0.0.1",
      "about:blank",
    ],
    {
      env: childEnv({}),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  let exited: number | undefined;
  proc.exited.then((code) => (exited = code)).catch(() => {});
  // Chromium's helpers inherit the pipe and can outlive the browser, so
  // stderr is read alongside the wait and never waited for to its end.
  const said: string[] = [];
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      said.push(decoder.decode(value, { stream: true }));
    }
  })().catch(() => {});
  const deadline = Date.now() + input.timeoutMs;
  const seconds = Math.round(input.timeoutMs / 1000);
  let devtools: Devtools | undefined;
  try {
    const url = await endpoint(profile, () => exited === undefined, deadline);
    if (url === undefined) {
      if (exited === undefined)
        return err(`the picture took longer than ${seconds}s`);
      // The browser's last words reach the pipe a beat after it exits.
      await Bun.sleep(150);
      // Chromium narrates its own housekeeping on stderr; the last line is
      // the one that says what went wrong, when anything did.
      const last = said
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !/crashpad|ProcessSingleton/i.test(l))
        .at(-1);
      return err(
        `chromium exited ${exited} without a picture${last === undefined ? "" : `: ${last.slice(0, 300)}`}`,
      );
    }
    const dt = (devtools = await within(
      Devtools.connect(url),
      deadline,
      `the picture took longer than ${seconds}s`,
    ));
    const work = (async (): Promise<Recorded> => {
      const { targetInfos } = (await dt.send("Target.getTargets")) as {
        targetInfos: { type: string; targetId: string }[];
      };
      const page = targetInfos.find(
        (t) => t.type === "page",
      );
      if (page === undefined) throw new Error("the browser opened no page");
      const { sessionId } = (await dt.send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      })) as { sessionId: string };
      await dt.send("Page.enable", {}, sessionId);
      // Loopback-only machines read as offline; say the page is online (the host mapping still limits reach).
      await dt.send("Network.enable", {}, sessionId);
      await dt.send(
        "Network.emulateNetworkConditions",
        {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        },
        sessionId,
      );
      await dt.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: input.width,
          height: input.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId,
      );
      if (input.dark === true)
        await dt.send(
          "Emulation.setEmulatedMedia",
          { features: [{ name: "prefers-color-scheme", value: "dark" }] },
          sessionId,
        );
      // Before navigation: the observer is in place before the page's first script.
      await dt.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: OBSERVER },
        sessionId,
      );
      const loaded = dt.heard("Page.loadEventFired", sessionId);
      const nav = await dt.send("Page.navigate", { url: input.url }, sessionId);
      // A page that never finishes loading is pictured as it stands.
      await Promise.race([loaded, Bun.sleep(LOAD_MS)]);
      await Bun.sleep(SETTLE_MS);
      const where = await dt.send(
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        sessionId,
      );
      const href = String(
        (where["result"] as { value?: unknown } | undefined)?.value ?? "",
      );
      const refused = refusal(
        host,
        typeof nav["errorText"] === "string" ? nav["errorText"] : undefined,
        href,
      );
      if (refused !== undefined) throw new Error(refused);
      let recorded = parseRecorded(undefined);
      try {
        const read = await dt.send(
          "Runtime.evaluate",
          {
            expression: READ,
            returnByValue: true,
          },
          sessionId,
        );
        const value = (read["result"] as { value?: unknown } | undefined)?.value;
        recorded = parseRecorded(JSON.parse(String(value ?? "null")));
      } catch {
        // No entries is not a failed look: the picture is still wanted.
      }
      const shot = await dt.send(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      );
      writeFileSync(input.out, Buffer.from(String(shot.data), "base64"));
      return recorded;
    })();
    work.catch(() => {});
    return ok(
      await within(work, deadline, `the picture took longer than ${seconds}s`),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message.startsWith("the picture took") ? message : `no picture: ${message}`);
  } finally {
    devtools?.close();
    if (exited === undefined) proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
    reader.cancel().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
