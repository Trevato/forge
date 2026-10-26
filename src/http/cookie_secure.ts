/**
 * The one rule for `Secure` on every cookie the forge sets: the request is
 * https, or the forge's own address is https. Behind a proxy that ends TLS
 * the request itself arrives as http, so the configured address is the fact
 * and the request is only a hint.
 */
export function secureFor(url: URL | undefined, forgeUrl?: string): boolean {
  return url?.protocol === "https:" || forgeUrl?.startsWith("https://") === true;
}
