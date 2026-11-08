/**
 * The browser entry point of a machine's shell page
 * (`/<owner>/<repo>/machines/<machine>/shell`, `web/pages/machines.ts`).
 * `web/asset.ts` bundles it with the vendored ghostty-web
 * (`src/web/vendor/ghostty-web`, MIT, pinned at 0.4.0) into one ES module served
 * from `/assets/machine-term-<hash>.js`; the emulator's WebAssembly is its own
 * immutable asset, named on the page as `data-wasm`, never inlined.
 *
 * Everything the page knows arrives in `data-*` attributes; the socket is the
 * page's own path, upgraded. All protocol work is in `machine-term-wire.ts`.
 */

import { FitAddon, Ghostty, Terminal, type ITheme } from "./vendor/ghostty-web/ghostty-web.js";
import { wire, type Term } from "./machine-term-wire.ts";

// The few browser globals this file touches, named here rather than pulling
// the whole DOM library into a server-side type check.
interface Box {
  readonly dataset: Record<string, string | undefined>;
  textContent: string | null;
  focus(): void;
}
declare const document: { getElementById(id: string): Box | null; readonly documentElement: unknown };
declare const location: { readonly href: string; readonly pathname: string; readonly protocol: string };
declare function getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
declare const ResizeObserver: new (callback: () => void) => { observe(element: unknown): void };

const REFIT_MS = 100;

const box = document.getElementById("machine-term");
const status = document.getElementById("machine-term-status");
const say = (words: string): void => {
  if (status !== null) status.textContent = words;
};

if (box !== null) {
  // Said here, not by the server: without JavaScript nothing connects (#9472).
  say("Connecting…");
  start(box).catch(() => say("The terminal could not start in this browser."));
}

/** The page's own colours and type, read from its tokens: the terminal follows the theme. */
function theme(): { theme: ITheme; fontFamily?: string } {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string): string | undefined => {
    const value = css.getPropertyValue(name).trim();
    return value === "" ? undefined : value;
  };
  const colours: ITheme = {};
  const background = token("--bg");
  const foreground = token("--fg");
  const cursor = token("--accent");
  if (background !== undefined) colours.background = background;
  if (foreground !== undefined) colours.foreground = foreground;
  if (cursor !== undefined) colours.cursor = cursor;
  const font = token("--mono");
  return font === undefined ? { theme: colours } : { theme: colours, fontFamily: font };
}

async function start(box: Box): Promise<void> {
  const wasm = box.dataset["wasm"];
  if (wasm === undefined) throw new Error("no wasm named");
  const ghostty = await Ghostty.load(wasm);
  const terminal = new Terminal({ ghostty, fontSize: 14, cursorBlink: true, ...theme() });
  const fitter = new FitAddon();
  terminal.loadAddon(fitter);
  terminal.open(box as never);

  const term: Term = {
    write: (bytes) => terminal.write(bytes),
    onData: (listener) => {
      terminal.onData(listener);
    },
    resize: (cols, rows) => terminal.resize(cols, rows),
    fit: () => {
      fitter.fit();
      return terminal.cols > 0 && terminal.rows > 0 ? { cols: terminal.cols, rows: terminal.rows } : undefined;
    },
  };

  const url = new URL(location.pathname, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const wired = wire(term, (frame) => socket.send(frame), say);
  socket.addEventListener("open", () => wired.opened());
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) wired.received(new Uint8Array(event.data));
  });
  socket.addEventListener("close", (event) => wired.closed(event.code, event.reason));

  // A window dragged wider fires many times; the shell hears the size it settles on.
  let timer: ReturnType<typeof setTimeout> | undefined;
  new ResizeObserver(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => wired.refit(), REFIT_MS);
  }).observe(box);
  terminal.focus();
}
