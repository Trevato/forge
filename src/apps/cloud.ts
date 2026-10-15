/**
 * The one gate every vendor call goes through (docs/CLOUD.md). A repository
 * may use a vendor only for what its `cloud.json` declares; with no file, or
 * a refused one, the answer is always no.
 */

import type { CloudDeclaration } from "./manifest.ts";

export function mayUse(
  declared: readonly CloudDeclaration[] | undefined,
  vendor: string,
  use: string,
): boolean {
  return (
    declared?.some((d) => d.vendor === vendor && d.use === use) ?? false
  );
}
