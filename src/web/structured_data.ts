/**
 * The front page's structured data (schema.org JSON-LD): the site as a
 * WebSite and the forge as a SoftwareApplication. Plain data in, a string
 * out; the page puts it in a `<script type="application/ld+json">`.
 */
import { SITE_LINE } from "./site_line.ts";

/** JSON that cannot close its own script tag: `<`, `>` and `&` are written as \u escapes. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function siteStructuredData(origin: string, version: string): string {
  return safeJson({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${origin}/#site`,
        name: "forge",
        url: `${origin}/`,
        description: SITE_LINE,
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${origin}/#software`,
        name: "forge",
        url: `${origin}/`,
        description: SITE_LINE,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        softwareVersion: version,
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
    ],
  });
}
