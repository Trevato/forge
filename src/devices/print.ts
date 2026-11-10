/**
 * An app printing through the forge. The app holds only its own token; the
 * forge decides: the token names the app, the owner's grant names the device,
 * and the address is the one declared, never one the request carries. The
 * document is checked here, before any byte leaves for the LAN.
 */

import type { App } from "../app.ts";
import { appOfToken, isGranted, type AppRef } from "../core/device_grants.ts";
import { getDevice, type Device } from "../core/devices.ts";
import { dailyCap, logJob, printedToday, type Outcome } from "../core/print_log.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { printPdf, type PrintJob } from "./ipp.ts";

export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_PAGES = 20;

/** Prints one app may start in a minute, and at once: each holds the forge up to the printer's own bound. */
export const PRINTS_PER_MINUTE = 10;
export const PRINTS_AT_ONCE = 2;

export type PrintError = "forbidden" | "rate_limited" | "daily_cap" | "not_pdf" | "too_large" | "too_many_pages" | "pages_unknown" | "printer_unreachable" | "printer_refused";

export const PRINT_WORDS: Record<PrintError, string> = {
  forbidden: "This app is not granted that printer.",
  rate_limited: "This app is printing too fast; wait a little.",
  daily_cap: "This app has used its prints for today on this printer; it can print again tomorrow.",
  not_pdf: "The body must be a PDF (application/pdf).",
  too_large: "The PDF is over 10 MB.",
  too_many_pages: "The PDF is over 20 pages.",
  pages_unknown: "The page count could not be read; save the PDF without compressed object streams.",
  printer_unreachable: "The printer did not answer.",
  printer_refused: "The printer did not accept the job.",
};

const latin = {
  decode: (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1"),
};

/**
 * The page count of a PDF read from its plain page tree: the largest `/Count`
 * of a `/Type /Pages` node, or the number of `/Type /Page` leaves, whichever is
 * greater. Zero when the file has an object stream (or a type name written
 * with `#` escapes), since the real tree could sit there while a plain
 * decoy node says `/Count 1`.
 */
export function pageCount(pdf: Uint8Array): number {
  const text = latin.decode(pdf);
  if (/\/ObjStm|\/Type\s*\/\w*#/.test(text)) return 0;
  const counted = [...text.matchAll(/\/Type\s*\/Page(?![A-Za-z])/g)].length;
  let declared = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages(?![A-Za-z])/g)) {
    const near = text.slice(Math.max(0, m.index - 300), m.index + 300);
    for (const c of near.matchAll(/\/Count\s+(\d+)/g)) declared = Math.max(declared, Number(c[1]));
  }
  return Math.max(counted, declared);
}

/** The body is a PDF within the limits, or why not. */
export function checkPdf(pdf: Uint8Array): Result<number, PrintError> {
  if (pdf.length > PDF_MAX_BYTES) return err("too_large");
  const tail = latin.decode(pdf.subarray(Math.max(0, pdf.length - 1024)));
  if (pdf.length < 8 || latin.decode(pdf.subarray(0, 5)) !== "%PDF-" || !tail.includes("%%EOF")) return err("not_pdf");
  const pages = pageCount(pdf);
  if (pages === 0) return err("pages_unknown");
  if (pages > PDF_MAX_PAGES) return err("too_many_pages");
  return ok(pages);
}

const perMinute = new RateLimiter({ perMinute: PRINTS_PER_MINUTE, adminPerMinute: PRINTS_PER_MINUTE, enabled: true });
const inFlight = new Map<string, number>();

/** Who is printing and where, decided from the token and the grant alone. */
export interface Permit {
  readonly caller: AppRef;
  readonly device: Device;
  /** Set once the reserved place is given back. */
  released: boolean;
}

/** Give back the place `permitPrint` reserved; safe to call twice. */
export function releasePermit(permit: Permit): void {
  if (permit.released) return;
  permit.released = true;
  const left = (inFlight.get(permit.caller.id) ?? 1) - 1;
  if (left <= 0) inFlight.delete(permit.caller.id);
  else inFlight.set(permit.caller.id, left);
}

/**
 * The app holding `secret` and the device it is granted, or `forbidden`
 * (so a caller learns nothing about devices it was not given), or
 * `rate_limited`, or `daily_cap`. Nothing of the body has been read yet: an
 * unknown or ungranted caller costs a lookup. A permit reserves its place
 * here, synchronously, so parallel requests are counted against the cap and
 * the at-once bound before any of them reads its body; whoever holds a permit
 * must `releasePermit` (printFor does).
 */
export function permitPrint(app: App, secret: string, deviceId: number): Result<Permit, PrintError> {
  const caller = appOfToken(app.db, secret);
  if (!caller || !Number.isSafeInteger(deviceId)) return err("forbidden");
  const device = getDevice(app.db, deviceId);
  if (!device || device.kind !== "printer" || !isGranted(app.db, device.id, caller.id)) return err("forbidden");
  const held = inFlight.get(caller.id) ?? 0;
  if (held >= PRINTS_AT_ONCE || !perMinute.take(caller.id, "ro").allowed) return err("rate_limited");
  // Jobs still in flight count, so parallel requests cannot slip past the last place.
  if (printedToday(app.db, device.id, caller.id) + held >= dailyCap(app.db, device.id, caller.id)) {
    logJob(app.db, { deviceId: device.id, appId: caller.id, pages: 0, outcome: "refused_cap" });
    return err("daily_cap");
  }
  inFlight.set(caller.id, held + 1);
  return ok({ caller, device, released: false });
}

/** Print `pdf` for a permitted app; the document is checked before any byte leaves for the LAN. */
export async function printFor(app: App, permit: Permit, pdf: Uint8Array): Promise<Result<PrintJob, PrintError>> {
  try {
    const { caller, device } = permit;
    const checked = checkPdf(pdf);
    const log = (pages: number, outcome: Outcome): void => logJob(app.db, { deviceId: device.id, appId: caller.id, pages, outcome });
    if (!checked.ok) {
      log(0, "refused_document");
      return checked;
    }
    const sent = await printPdf(device.url, pdf, `${caller.slug} (forge)`);
    log(checked.value, sent.ok ? "printed" : "failed");
    releasePermit(permit);
    if (sent.ok) {
      app.bus.append({ kind: "device.printed", payload: { device: device.name, app: caller.slug, pages: checked.value } });
      return ok(sent.job);
    }
    return err(sent.error === "unreachable" ? "printer_unreachable" : "printer_refused");
  } finally {
    releasePermit(permit);
  }
}
