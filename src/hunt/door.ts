/**
 * Front door: an anonymous visitor to a page that needs a person is sent to
 * sign-in with a way back, an unknown path is a plain 404, and the public top
 * pages answer.
 */

import { found, seenLine, type Finding } from "./finding.ts";
import type { Probe } from "./probe.ts";

export const PERSONAL_PAGES = ["/settings", "/new", "/migrate", "/review"];
export const PUBLIC_PAGES = ["/", "/signin", "/explore", "/apps", "/healthz"];

export async function frontDoor(p: Probe): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const path of PERSONAL_PAGES) {
    const r = await p.get(path);
    const sent = r.status >= 300 && r.status < 400 && /\/signin(\?|$)/.test(r.location ?? "");
    if (!sent)
      out.push(found("door.signin-redirect", path, `${path} does not send an anonymous visitor to sign-in`, seenLine(path, r.status, r.location)));
    else if (!(r.location ?? "").includes("next="))
      out.push(found("door.signin-next", path, `${path} sends to sign-in without a way back`, seenLine(path, r.status, r.location)));
  }
  for (const path of PUBLIC_PAGES) {
    const r = await p.get(path);
    if (r.status !== 200) out.push(found("door.public-page", path, `${path} does not answer 200 to an anonymous visitor`, seenLine(path, r.status, r.location)));
  }
  const missing = "/no-such-page-hunter";
  const r = await p.get(missing);
  if (r.status !== 404) out.push(found("door.unknown-404", missing, "an unknown path does not answer 404", seenLine(missing, r.status, r.location)));
  return out;
}
