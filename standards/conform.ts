/**
 * The harness of the conformance suite: where the forge and the app are, and
 * `conform`, a test that, when it fails, names the standard, its version and
 * the page it breaks. Black-box: nothing here imports the forge.
 */
import { test } from "bun:test";

export const FORGE_URL = (process.env["FORGE_URL"] ?? "").replace(/\/+$/, "");
export const FORGE_TOKEN = process.env["FORGE_TOKEN"] ?? "";
export const APP_URL = (process.env["APP_URL"] ?? "").replace(/\/+$/, "");
export const APP_ADAPTER = process.env["APP_ADAPTER"] === "1";

/** The versions this suite tests, one per page in docs/standards/. */
export const VERSION = 1;
export type StandardId = "app-manifest" | "identity" | "permissions" | "feedback" | "adapters";

/** A check that, failing, says which standard page it breaks. */
export function conform(id: StandardId, name: string, run: () => Promise<void> | void, enabled = true): void {
  const t = enabled ? test : test.skip;
  t(`${id}: ${name}`, async () => {
    try {
      await run();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`[${id} v${VERSION}: docs/standards/${id}.md] ${why}`);
    }
  });
}

export function must(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

export async function forge(path: string, init: RequestInit & { token?: boolean } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${FORGE_TOKEN}`);
  return fetch(FORGE_URL + path, { ...init, headers, redirect: "manual" });
}
