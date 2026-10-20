/**
 * The website specification run against a live preview (#2955). Report-only:
 * a `webspec()` that throws or runs out of time is one finding, never an
 * error, and nothing here can fail a deploy.
 */

import { recordPreviewFindings } from "../core/preview_findings.ts";
import { webspec, type Finding } from "../release/webspec.ts";
import type { Database } from "bun:sqlite";
import { createLog } from "../kernel/log.ts";

const log = createLog("preview-spec");

/** The smoke proof's own patience for a whole run. */
export const PREVIEW_SPEC_TIMEOUT_MS = 30_000;

const SECTION = "https://specification.website/";

/** `webspec()` over `paths` at `base`, with a clock; never throws. */
export async function previewSpec(
  base: string,
  paths: readonly string[],
  timeoutMs = PREVIEW_SPEC_TIMEOUT_MS,
): Promise<Finding[]> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    const fetcher = (input: string, init?: RequestInit) =>
      fetch(input, { ...init, signal: stop.signal });
    return await Promise.race([webspec(base, [...paths], fetcher), clock]);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return [{ path: "/", check: "webspec", message: `webspec could not finish: ${why}`, section: SECTION }];
  } finally {
    clearTimeout(timer);
  }
}

/** Check a live preview and keep what was found under its run; never throws. */
export async function checkPreview(
  db: Database,
  runId: string,
  base: string,
  paths: readonly string[],
  timeoutMs = PREVIEW_SPEC_TIMEOUT_MS,
): Promise<void> {
  const findings = await previewSpec(base, paths, timeoutMs);
  try {
    recordPreviewFindings(db, runId, findings);
  } catch (error) {
    // The forge closing under a late check, or the run gone: nothing to report to.
    log.warn("could not record a preview's website-spec findings", { run: runId, error: String(error) });
  }
}
