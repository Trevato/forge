/**
 * Measuring a page's width in a real, headless Chromium — the only way to
 * hold "the page never scrolls sideways" here rather than trust it by
 * reading the CSS. A minimal CDP client over the WebSocket the runtime
 * already gives us: one browser, its one open page, three domains (Page,
 * Network, Emulation), no dependency beyond `findChromium`
 * (`src/looks/capture.ts`), which already knows where the binary is on this
 * machine.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../src/apps/process.ts";

export interface PageWidth {
  /** `document.documentElement.scrollWidth` once the page has loaded. */
  scrollWidth: number;
  viewportWidth: number;
  /** Up to a handful of elements whose right edge sits past the viewport. */
  overflowing: string[];
}

interface CdpMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
}

/**
 * `promise`, or a rejection naming `what` after `ms`: every wait on chromium
 * is bounded, so a stalled browser fails the test and the `finally` that
 * kills it runs, instead of hanging the shard until it is killed.
 */
function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chromium: ${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A CDP session over one page's own devtools socket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (msg: CdpMessage) => void>();
  private readonly waiters = new Map<string, () => void>();
  private readonly listeners = new Map<string, ((params: any) => void)[]>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as CdpMessage & {
        method?: string;
        params?: unknown;
      };
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      } else if (msg.method !== undefined) {
        this.waiters.get(msg.method)?.();
        this.waiters.delete(msg.method);
        for (const listen of this.listeners.get(msg.method) ?? [])
          listen(msg.params);
      }
    });
  }

  /** Every time `method` fires as an event, with its params. */
  on(method: string, listen: (params: any) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listen]);
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    return within(5_000, method, new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    }));
  }

  /** Resolves the next time `method` fires as an event — a one-shot wait. */
  once(method: string): Promise<void> {
    return new Promise((resolve) => this.waiters.set(method, resolve));
  }
}

/** The devtools http endpoint's own list of open pages. */
async function findPageTarget(
  debuggerWsUrl: string,
): Promise<{ webSocketDebuggerUrl: string }> {
  const httpBase = debuggerWsUrl
    .replace(/^ws:/, "http:")
    .replace(/\/devtools\/browser\/.*$/, "");
  const res = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(5_000) });
  const list = (await res.json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = list.find((t) => t.type === "page");
  if (page === undefined) throw new Error("chromium opened no page to drive");
  return page;
}

/** Chromium prints its devtools address to stderr once it is ready to drive. */
async function readDebuggerUrl(
  stderr: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("chromium exited before printing its devtools address");
      buf += decoder.decode(value, { stream: true });
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) return match[1]!;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Load `url` in headless Chromium at a `width`×`height` viewport, carrying
 * cookies and the given colour scheme, and return what `expression` (a JS
 * expression that yields a JSON string) says once the page has loaded.
 */
export async function evaluateLoaded(
  binary: string,
  url: string,
  viewport: { width: number; height: number },
  cookies: { name: string; value: string }[],
  expression: string,
  scheme: "light" | "dark" = "light",
): Promise<string> {
  const profile = mkdtempSync(join(tmpdir(), "forge-phone-"));
  const proc = Bun.spawn(
    [
      binary,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-crash-reporter",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
    ],
    { env: childEnv({}), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  let ws: WebSocket | undefined;
  try {
    const browserWsUrl = await Promise.race([
      readDebuggerUrl(proc.stderr),
      Bun.sleep(10_000).then((): string => {
        throw new Error("chromium never printed its devtools address");
      }),
    ]);
    const page = await findPageTarget(browserWsUrl);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await within(5_000, "opening the devtools socket", new Promise<void>((resolve, reject) => {
      ws!.addEventListener("open", () => resolve());
      ws!.addEventListener("error", () =>
        reject(new Error("chromium's devtools socket refused the connection")),
      );
    }));
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    // The viewport a real phone gives a page: window-size flags at launch
    // are not honoured without a display, so this is what actually sets it.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    for (const cookie of cookies)
      await cdp.send("Network.setCookie", {
        name: cookie.name,
        value: cookie.value,
        url,
      });
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url });
    await within(10_000, `loading ${url}`, loaded);
    // The load event can be the blank start page's, fired late on a busy
    // machine: the page measured is the navigated one, loaded, or none.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { result: at } = await cdp.send("Runtime.evaluate", {
        expression: `/^https?:/.test(location.href) && document.readyState === "complete"`,
        returnByValue: true,
      });
      if (at.value === true) break;
      if (Date.now() > deadline) throw new Error(`chromium never finished loading ${url}`);
      await Bun.sleep(25);
    }
    const { result } = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.value as string;
  } finally {
    ws?.close();
    proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Load `url` and report how wide the document ended up. */
export async function measurePageWidth(
  binary: string,
  url: string,
  viewport: { width: number; height: number },
  cookie: { name: string; value: string },
): Promise<PageWidth> {
  const expression = `(() => {
          // documentElement.clientWidth, not window.innerWidth: after an
          // in-process navigation under an active device-metrics override,
          // headless Chromium leaves window.innerWidth stale while every
          // other viewport-derived value (this one included) is current.
          const vw = document.documentElement.clientWidth;
          const overflowing = [...document.querySelectorAll("*")]
            .filter((el) => el.getBoundingClientRect().right > vw + 1)
            .slice(0, 8)
            .map((el) =>
              el.tagName.toLowerCase() +
              (el.className && typeof el.className === "string"
                ? "." + el.className.trim().split(/\\s+/).join(".")
                : ""),
            );
          return JSON.stringify({
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: vw,
            overflowing,
          });
        })()`;
  return JSON.parse(
    await evaluateLoaded(binary, url, viewport, [cookie], expression),
  ) as PageWidth;
}

/** A button that looks busy: marked `aria-busy`, or holding a running animation. */
export interface BusyButton {
  button: string;
  why: string;
}

/**
 * Load `url` at rest and list every `button` and `.btn` that is busy or
 * spinning: `aria-busy="true"` on it, or inside it an element (or the
 * button itself) whose computed `animation-name` is not `none`.
 */
export async function findBusyButtons(
  binary: string,
  url: string,
  viewport: { width: number; height: number },
  cookies: { name: string; value: string }[],
  scheme: "light" | "dark",
): Promise<{ buttons: number; busy: BusyButton[] }> {
  const expression = `(() => {
    const name = (el) =>
      el.tagName.toLowerCase() +
      (typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\\s+/).join(".")
        : "") + " [" + (el.textContent || "").trim().slice(0, 30) + "]";
    const all = [...document.querySelectorAll("button, .btn")];
    const busy = [];
    for (const b of all) {
      if (b.getAttribute("aria-busy") === "true")
        busy.push({ button: name(b), why: "aria-busy" });
      for (const el of [b, ...b.querySelectorAll("*")]) {
        const a = getComputedStyle(el).animationName;
        if (a !== "none")
          busy.push({ button: name(b), why: "animation " + a + " on " + el.tagName.toLowerCase() + "." + String(el.getAttribute("class")) });
      }
    }
    return JSON.stringify({ buttons: all.length, busy });
  })()`;
  return JSON.parse(
    await evaluateLoaded(binary, url, viewport, cookies, expression, scheme),
  );
}

/**
 * Whether `binary` can actually start headless here. A binary on the path
 * is not a browser that runs: a sandbox that forbids sockets kills it at
 * launch. Tests skip, named, on `false` rather than fail or pass silently.
 */
export function chromiumRuns(binary: string): boolean {
  const profile = mkdtempSync(join(tmpdir(), "forge-probe-"));
  try {
    const probe = Bun.spawnSync(
      [
        binary,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--dump-dom",
        "about:blank",
      ],
      { env: childEnv({}), stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 15_000 },
    );
    return probe.exitCode === 0 && probe.stdout.toString().includes("<html");
  } catch {
    return false;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/** What a browser did after a click: where it went, and what it refused. */
export interface Followed {
  /** Every URL the page asked for, in order (navigations and redirects). */
  readonly requested: string[];
  /** The page's URL when following stopped. */
  readonly finalUrl: string;
  /**
   * Console errors, log entries and `securitypolicyviolation` events: a
   * Content-Security-Policy refusal lands here, however the browser says it.
   */
  readonly errors: string[];
}

/**
 * Load `url` with a session cookie, then run each of `steps` (an
 * expression evaluated in the page — a click) after the page before it has
 * loaded, and follow the browser until a requested URL satisfies `until` or
 * `timeoutMs` passes. What a real browser enforces and an HTTP client does
 * not — a page's CSP on the redirect that follows its form — is exactly
 * what this sees.
 */
export async function clickAndFollow(
  binary: string,
  input: {
    url: string;
    cookie: { name: string; value: string };
    steps: readonly string[];
    until: (url: string) => boolean;
    /** Done for another reason the page cannot see (a server got the request). */
    done?: () => boolean;
    timeoutMs?: number;
  },
): Promise<Followed> {
  const profile = mkdtempSync(join(tmpdir(), "forge-click-"));
  const proc = Bun.spawn(
    [
      binary,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-crash-reporter",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
    ],
    { env: childEnv({}), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  let ws: WebSocket | undefined;
  const requested: string[] = [];
  const errors: string[] = [];
  try {
    const browserWsUrl = await Promise.race([
      readDebuggerUrl(proc.stderr),
      Bun.sleep(10_000).then((): string => {
        throw new Error("chromium never printed its devtools address");
      }),
    ]);
    const target = await findPageTarget(browserWsUrl);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener("open", () => resolve());
      ws!.addEventListener("error", () =>
        reject(new Error("chromium's devtools socket refused the connection")),
      );
    });
    const cdp = new Cdp(ws);
    cdp.on("Network.requestWillBeSent", (p) => requested.push(String(p.request?.url ?? "")));
    cdp.on("Log.entryAdded", (p) => {
      if (p.entry?.level === "error" || p.entry?.source === "security")
        errors.push(String(p.entry?.text ?? ""));
    });
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error")
        errors.push((p.args ?? []).map((a: any) => String(a.value ?? a.description ?? "")).join(" "));
    });
    cdp.on("Audits.issueAdded", (p) => {
      const csp = p.issue?.details?.contentSecurityPolicyIssueDetails;
      if (csp !== undefined)
        errors.push(`CSP issue: ${csp.violatedDirective} ${csp.blockedURL ?? ""}`);
    });
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Audits.enable");
    // Every document reports its own CSP refusals, before anything else runs.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `document.addEventListener("securitypolicyviolation", (e) =>
        console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI));`,
    });
    await cdp.send("Network.setCookie", {
      name: input.cookie.name,
      value: input.cookie.value,
      url: input.url,
    });
    const deadline = Date.now() + (input.timeoutMs ?? 15_000);
    const reached = () =>
      requested.some(input.until) || (input.done?.() ?? false);
    let loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: input.url });
    await Promise.race([loaded, Bun.sleep(Math.max(0, deadline - Date.now()))]);
    for (const step of input.steps) {
      if (reached()) break;
      loaded = cdp.once("Page.loadEventFired");
      // As a person's click: a user gesture, so a link that opens a tab does.
      await cdp.send("Runtime.evaluate", { expression: step, userGesture: true });
      await Promise.race([loaded, Bun.sleep(Math.max(0, deadline - Date.now()))]);
    }
    while (!reached() && Date.now() < deadline) await Bun.sleep(100);
    // Late reports of what the last navigation refused.
    await Bun.sleep(300);
    const where = await cdp
      .send("Runtime.evaluate", { expression: "location.href", returnByValue: true })
      .catch(() => ({ result: { value: "" } }));
    return { requested, finalUrl: String(where.result?.value ?? ""), errors };
  } finally {
    ws?.close();
    proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
