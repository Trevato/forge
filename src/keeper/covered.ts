/**
 * The release proof looks at a phone (#11855, #11831 item 4). A 200 is not
 * proof a person can use a page: release 0.7.549 answered every probe while a
 * closed dialog was drawn over every page on a phone. After the load probes,
 * the home page, the forge's repository page and the apps page are opened at
 * 390×844 in headless Chromium, signed in as the verify's admin, with nothing
 * opened; the element at the centre of the screen must not be a dialog, a
 * popover or a `position: fixed` layer bigger than a quarter of the viewport.
 * One that is fails the verify, and the release rolls back like any other.
 *
 * A false positive rolls a good release back, so a blank centre is looked at
 * twice: after a short settle, then once more after a long one, and only a
 * centre that is still empty fails. A page that fails to load is not a cover
 * (the load probes report it). A `hidden` hit means an element with the
 * `hidden` attribute that elementFromPoint still returns: `[hidden]` is
 * `display:none` until some CSS overrides it, so that is exactly the case the
 * check catches, an author rule that un-hid what was meant to be closed. The
 * whole phone step has a deadline, so a hung browser cannot stall the verify.
 *
 * `centreVerdict` is plain data in, a reason (or nothing) out; `probeCentre`
 * is the browser. A forge with no browser cannot look: it says so and does
 * not fail the release for it.
 */

import { findChromium } from "../looks/capture.ts";
import { withPage } from "../release/devtools.ts";

/** A phone: the viewport the look is taken at, in CSS pixels. */
export const PHONE = { width: 390, height: 844 } as const;
/** A layer over this share of the viewport, at the centre, covers the page. */
export const COVER_SHARE = 0.25;
/** Settle before the first read, and before the one retry of a blank centre. */
export const SETTLE_MS = 500;
export const RETRY_SETTLE_MS = 3000;
/** The whole phone step, and one look, in milliseconds: a hung browser fails open, not the release. */
export const PHONE_DEADLINE_MS = 60_000;
export const LOOK_DEADLINE_MS = 20_000;

/** A look at one page: after `settleMs` of settling, the centre it saw, or undefined when it could not look. */
export type Look = (path: string, settleMs: number) => Promise<Centre | undefined>;

/** One element from the centre point up to the root, as the page reports it. */
export interface Layer {
  readonly tag: string;
  readonly position: string;
  readonly popover: boolean;
  readonly hidden: boolean;
  /** Its box, in CSS pixels, clipped to the viewport. */
  readonly width: number;
  readonly height: number;
}

/** What the page saw at its centre: the layers from the topmost element up. */
export interface Centre {
  readonly layers: readonly Layer[];
}

/**
 * Runs in the page: the layers at the centre, topmost first. The page's
 * words are narrowed by `parseCentre`; nothing here is trusted.
 */
export const CENTRE_SCRIPT = `(() => {
  const w = window.innerWidth, h = window.innerHeight;
  const out = [];
  for (let e = document.elementFromPoint(w / 2, h / 2); e && e !== document.documentElement; e = e.parentElement) {
    const r = e.getBoundingClientRect();
    out.push({
      tag: e.localName,
      position: getComputedStyle(e).position,
      popover: e.hasAttribute("popover"),
      hidden: e.hasAttribute("hidden"),
      width: Math.max(0, Math.min(r.right, w) - Math.max(r.left, 0)),
      height: Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0)),
    });
  }
  return JSON.stringify({ layers: out });
})()`;

/** The page's report narrowed to numbers and strings of a bounded size; anything else is no layers. */
export function parseCentre(raw: unknown): Centre {
  let from: unknown = raw;
  if (typeof raw === "string") {
    try {
      from = JSON.parse(raw);
    } catch {
      return { layers: [] };
    }
  }
  const list = (from as { layers?: unknown } | null)?.layers;
  if (!Array.isArray(list)) return { layers: [] };
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const layers: Layer[] = [];
  for (const item of list.slice(0, 64)) {
    if (item === null || typeof item !== "object") continue;
    const l = item as Record<string, unknown>;
    layers.push({
      tag: typeof l["tag"] === "string" ? l["tag"].slice(0, 40) : "",
      position: typeof l["position"] === "string" ? l["position"].slice(0, 20) : "",
      popover: l["popover"] === true,
      hidden: l["hidden"] === true,
      width: num(l["width"]),
      height: num(l["height"]),
    });
  }
  return { layers };
}

/**
 * Why the centre of the screen is covered, or undefined when it is not. The
 * topmost element and its ancestors are asked: a dialog, a popover, a
 * `hidden` element, or a fixed layer over a quarter of the viewport is a
 * cover (a fixed header or a toast is small and does not count). No layers at
 * all is a page with nothing at its centre, which is a cover of its own kind.
 */
export function centreVerdict(c: Centre, viewport: { width: number; height: number } = PHONE): string | undefined {
  if (c.layers.length === 0) return "nothing is drawn at the centre of the screen";
  const area = viewport.width * viewport.height;
  for (const l of c.layers) {
    const share = (l.width * l.height) / area;
    if (l.tag === "dialog") return `a <dialog> covers the centre of the screen (${Math.round(share * 100)}% of it)`;
    if (l.popover) return `a [popover] <${l.tag}> covers the centre of the screen`;
    if (l.hidden) return `a hidden <${l.tag}> is drawn at the centre of the screen`;
    if (l.position === "fixed" && share > COVER_SHARE)
      return `a fixed <${l.tag}> covers ${Math.round(share * 100)}% of the screen, centre included`;
  }
  return undefined;
}

export interface PhoneVerdict {
  readonly ok: boolean;
  /** One line naming the page and what covers it; empty when ok. */
  readonly reason: string;
  /** How many pages were looked at; 0 when no browser was there. */
  readonly looked: number;
}

/** `p`, or undefined when it has not answered in `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), Bun.sleep(ms).then(() => undefined)]);
}

/**
 * Look at each page through `look` and fail on the first covered one. A look
 * that could not be made (an error, a timeout, the deadline passing) is not a
 * cover. A blank centre is looked at once more after the longer settle.
 */
export async function verifyPhone(
  pages: readonly string[],
  look: Look,
  opts: { now?: () => number; deadlineMs?: number; lookMs?: number } = {},
): Promise<PhoneVerdict> {
  const now = opts.now ?? Date.now;
  const end = now() + (opts.deadlineMs ?? PHONE_DEADLINE_MS);
  const lookMs = opts.lookMs ?? LOOK_DEADLINE_MS;
  let looked = 0;
  for (const path of pages) {
    if (now() >= end) break;
    let c = await within(look(path, SETTLE_MS), lookMs);
    if (c !== undefined && c.layers.length === 0 && now() < end) c = (await within(look(path, RETRY_SETTLE_MS), lookMs)) ?? c;
    if (c === undefined) continue;
    looked++;
    const why = centreVerdict(c);
    if (why !== undefined) return { ok: false, reason: `${path} at ${PHONE.width}×${PHONE.height}: ${why}`, looked };
  }
  return { ok: true, reason: "", looked };
}

/**
 * The phone step of a verify: the load result unchanged when there is no
 * browser (`look` undefined) or nothing is covered; otherwise a failure naming
 * the cover. Kept out of the keeper's closure so it can be tested.
 */
export async function phoneGate<T extends { ok: boolean; tally: unknown }>(
  loaded: T,
  pages: readonly string[],
  look: Look | undefined,
  opts?: Parameters<typeof verifyPhone>[2],
): Promise<T | { ok: false; tally: T["tally"]; reason: string }> {
  if (!loaded.ok || look === undefined) return loaded;
  const phone = await verifyPhone(pages, look, opts);
  return phone.ok ? loaded : { ok: false, tally: loaded.tally, reason: `covered at phone size: ${phone.reason}` };
}

/** The browser's look: each page opened at phone size, signed in by the session cookie, read at its centre. */
export function probeCentre(base: string, cookie: { name: string; value: string } | undefined): Look | undefined {
  const binary = findChromium();
  if (binary === undefined) return undefined;
  return (path, settleMs) =>
    withPage(binary, async (send, once) => {
      await send("Page.enable");
      await send("Emulation.setDeviceMetricsOverride", { ...PHONE, deviceScaleFactor: 1, mobile: true });
      if (cookie !== undefined) await send("Network.setCookie", { ...cookie, url: base, httpOnly: true });
      const loaded = once("Page.loadEventFired").catch(() => {});
      await send("Page.navigate", { url: new URL(path, base).toString() });
      await loaded;
      await Bun.sleep(settleMs);
      const read = await send("Runtime.evaluate", { expression: CENTRE_SCRIPT, returnByValue: true });
      return parseCentre(read?.result?.value);
    });
}
