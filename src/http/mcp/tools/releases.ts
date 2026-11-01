import { getRepoById } from "../../../core/repos.ts";
import { listReleases, releaseName } from "../../../release/record.ts";
import { BOOTED, mayRead } from "../../../release/gate.ts";
import { readLandings } from "../../../release/landings.ts";
import { running } from "../../../kernel/version.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "releases",
  doc: "`{shipped: true}`: what went live, for anyone: `version`, `commit`, `live` (newest first: `repo`, `number`, `title`, `at`) and `onItsWay` (landed, not yet in the running commit), the list /changelog shows. `{}`: the forge's kept releases newest first: short sha, version, the pull that landed it, when, and for the live one `live: true` and `since`; for whoever may read /releases, others get its refusal; no rollback, a person does that on the page",
  description: "Kept releases, newest first.",
  inputSchema: { type: "object", properties: { shipped: { type: "boolean" } } },
  writes: false,
  async run(ctx, user, args) {
    if (args["shipped"] === true) {
      const { version, commit, live, onItsWay } = await readLandings(ctx.app);
      return good({ version, commit, live, onItsWay });
    }
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
