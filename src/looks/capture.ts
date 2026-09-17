/**
 * Taking a picture of a page. Headless Chromium is spawned with the one
 * flag that writes a screenshot, pointed at a URL on the forge's own
 * listener with the app's hostname resolved to loopback, so the page is
 * served the way a person would be served it — through the proxy, the
 * grant, and the identity headers — without an edge in the way.
 *
 * Chromium's `--screenshot` sets no headers and no cookies. So the URL is
 * not the page but the app's grant door (`/__forge/grant?t=…&to=/`): that
 * one navigation sets the grant cookie and lands on the page as the person
 * the grant names. Chromium follows the redirect and pictures where it
 * lands.
 *
 * The picture is taken as the page loads, bounded by `--timeout` for a
 * page that never finishes — not after a virtual-time budget: a page that
 * holds an event stream open (the scaffold's live script does) never goes
 * idle, and a budget waits forever for it. What an app draws after load is
 * not in the picture; what it serves is. And the picture, not the
 * browser's exit, is what is waited for: a PNG whose IEND chunk is on disk
 * is complete, and a browser that has written it is killed rather than
 * asked to leave — Chrome 144 on macOS writes the file and then sits.
 *
 * One picture at a time, forge-wide: a browser is the heaviest thing this
 * process starts, and a pod that holds two agent runs has room for one.
 */

import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../apps/process.ts";
import { Gate } from "../git/env.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface LookInput {
  /** The URL to open — the grant door of the app's hostname, on the forge's own port. */
  readonly url: string;
  /** Where the picture goes; whatever is there is replaced. */
  readonly out: string;
  readonly width: number;
  readonly height: number;
  /** A browser that has no picture by then is killed; the look fails. */
  readonly timeoutMs: number;
}

/** What takes the picture: the real browser, or a test's stand-in. */
export type Capture = (input: LookInput) => Promise<Result<void, string>>;

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
): Promise<Result<void, string>> {
  const binary = findChromium();
  if (binary === undefined)
    return err("no chromium on this forge: install one, or set FORGE_CHROMIUM");
  const release = await gate.acquire();
  try {
    return await shoot(binary, input);
  } finally {
    release();
  }
}

/** The last eight bytes of every PNG: the IEND chunk and its CRC. */
const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** Whether a complete picture is on disk at `path`. */
function pictureDone(path: string): boolean {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  if (size < 64) return false;
  const fd = openSync(path, "r");
  try {
    const tail = Buffer.alloc(8);
    readSync(fd, tail, 0, 8, size - 8);
    return tail.equals(PNG_END);
  } finally {
    closeSync(fd);
  }
}

async function shoot(
  binary: string,
  input: LookInput,
): Promise<Result<void, string>> {
  const host = new URL(input.url).hostname;
  // A profile of its own, gone afterwards: no cookie outlives its picture,
  // and two forges in one process never share a browser's state.
  const profile = mkdtempSync(join(tmpdir(), "forge-look-"));
  rmSync(input.out, { force: true });
  const proc = Bun.spawn(
    [
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
      "--hide-scrollbars",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      // The app's hostname is the forge's own listener: no DNS, no edge.
      `--host-resolver-rules=MAP ${host} 127.0.0.1`,
      `--window-size=${input.width},${input.height}`,
      "--force-device-scale-factor=1",
      "--js-flags=--max-old-space-size=256",
      `--timeout=${LOAD_MS}`,
      `--screenshot=${input.out}`,
      input.url,
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
  try {
    for (;;) {
      if (pictureDone(input.out)) return ok();
      if (exited !== undefined) {
        // The browser's last words reach the pipe a beat after it exits.
        await Bun.sleep(150);
        break;
      }
      if (Date.now() >= deadline)
        return err(
          `the picture took longer than ${Math.round(input.timeoutMs / 1000)}s`,
        );
      await Bun.sleep(100);
    }
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
  } finally {
    if (exited === undefined) proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
    reader.cancel().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
