import { getRepoById } from "../../../core/repos.ts";
import { listReleases, releaseName } from "../../../release/record.ts";
import { BOOTED, mayRead } from "../../../release/gate.ts";
import { running } from "../../../kernel/version.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "releases",
  doc: "`{}`: the forge's kept releases newest first: short sha, version, the pull that landed it, when, and for the live one `live: true` and `since`; for whoever may read /releases, others get its refusal; no rollback, a person does that on the page",
  description: "Kept releases, newest first.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    // The page's own gate: its refusal, in words.
    if (!mayRead(ctx.app, user))
      return bad("forbidden", "the release history is for the forge's administrators and its repository's readers");
    const live = running();
    return good({
      items: listReleases(ctx.app.db).map((r) => {
        const isLive = live.commit !== null && r.sha === live.commit;
        const repo = getRepoById(ctx.app.db, r.repoId);
        return {
          sha: releaseName(r),
          version: isLive ? live.version : null,
          pull: r.pullNumber === null ? null : { repo: repo === undefined ? null : `${repo.ownerName}/${repo.name}`, number: r.pullNumber },
          landed: r.createdAt,
          ok: r.ok,
          ...(isLive ? { live: true, since: BOOTED } : {}),
        };
      }),
    });
  },
};
