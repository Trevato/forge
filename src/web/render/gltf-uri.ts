/**
 * Which URIs a `.gltf` may make the reader's browser fetch. A glTF names its
 * buffers and images by URI, and the file is anyone's: left alone, a public
 * model could say `../../../settings/tokens` or `/api/v1/…` and every reader
 * would send a credentialed request there. So the viewer's loader asks this
 * first, and only a file beside the model, or below it, on the same media
 * route, is fetched (`model3d-client.ts`).
 *
 * Plain strings in, a boolean out: the tests ask it what the browser would.
 */

/** Where a refused URI is sent: nowhere, and no request leaves the page. */
export const REFUSED_URI = "about:blank#refused";

/**
 * Whether `uri`, resolved the way the browser will (against `dir`, itself
 * resolved against `page`), is a same-origin http(s) address whose path lies
 * under `dir`'s. An encoded dot, slash or backslash is refused outright, so
 * no server's decoding can walk it back out.
 */
export function withinModelDir(uri: string, dir: string, page: string): boolean {
  let base: URL;
  let target: URL;
  try {
    base = new URL(dir, page);
    target = new URL(uri, base);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (target.origin !== base.origin) return false;
  if (target.username !== "" || target.password !== "") return false;
  const path = target.pathname;
  if (/%(2e|2f|5c)/i.test(path) || path.includes("\\")) return false;
  const root = base.pathname.endsWith("/") ? base.pathname : base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
  return path.startsWith(root) && path.length > root.length;
}
