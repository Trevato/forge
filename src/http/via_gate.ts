/**
 * The one gate every via-token request passes, before any handler (#7649).
 *
 * A via token (`core/via_token.ts`) is the forge's own agent speaking for one
 * person, and the fence that keeps others' text from steering it — every
 * answer fenced as data, a write the person did not name held as a confirm —
 * lives in `/mcp` alone (`http/mcp/shared.ts`). So `POST /mcp` is the only
 * door it opens: the API, the pages and git answer 403, or a steered agent
 * would write there unfenced and unheld. Allow-listed, so a door added
 * tomorrow is closed to these tokens until it carries the fence.
 */

import type { Auth } from "./context.ts";
import { apiError } from "./respond.ts";

export function viaGate(request: Request, url: URL, auth: Auth): Response | undefined {
  if (auth.through === undefined) return undefined;
  if (request.method === "POST" && url.pathname === "/mcp") return undefined;
  return apiError("forbidden", 403, "a conversation's token reaches the forge only through /mcp");
}
