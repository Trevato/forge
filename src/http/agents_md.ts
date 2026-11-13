/**
 * `GET /:owner/:name/AGENTS.md`: how to work on this repository. The
 * repository's own root AGENTS.md when it has one, else a generated text
 * (`web/doors_words.ts`). Anyone who may read the repository may read it; a
 * private one answers 404 like every other page. Served as text, never as a page.
 */

import { canRead, getRepo } from "../core/repos.ts";
import { agentsMdOf } from "../view/agents_md.ts";
import type { Handler } from "./context.ts";
import { securityFloor } from "./respond.ts";

const plain = (body: string, status: number, own: boolean): Response =>
  securityFloor(
    new Response(body, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "private, no-cache",
        vary: "Cookie, Authorization",
        "x-forge-agents-md": own ? "own" : "generated",
      },
    }),
  );

export const agentsMd: Handler = async (ctx) => {
  const repo = getRepo(ctx.app.db, ctx.params.owner ?? "", (ctx.params.name ?? "").replace(/\.git$/, ""));
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return plain("not found\n", 404, false);
  const found = await agentsMdOf(ctx.app.reposRoot, repo, ctx.url.origin);
  return plain(found.text, 200, found.source === "own");
};
