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

/** A CDP session over one page's own devtools socket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (msg: CdpMessage) => void>();
  private readonly waiters = new Map<string, () => void>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as CdpMessage & {
        method?: string;
      };
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      } else if (msg.method !== undefined) {
        this.waiters.get(msg.method)?.();
        this.waiters.delete(msg.method);
      }
    });
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
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
  const list = (await (await fetch(`${httpBase}/json/list`)).json()) as {
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
 * one cookie (a session), and report how wide the document ended up.
 */
export async function measurePageWidth(
  binary: string,
  url: string,
  viewport: { width: number; height: number },
  cookie: { name: string; value: string },
): Promise<PageWidth> {
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
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener("open", () => resolve());
      ws!.addEventListener("error", () =>
        reject(new Error("chromium's devtools socket refused the connection")),
      );
    });
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
    await cdp.send("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      url,
    });
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url });
    await loaded;
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
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
        })()`,
      returnByValue: true,
    });
    return JSON.parse(result.value as string) as PageWidth;
  } finally {
    ws?.close();
    proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
