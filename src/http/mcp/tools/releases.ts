import { releasesAnswer, shippedAnswer } from "../../../release/answer.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "releases",
  doc: "`{shipped: true, repo?}`: what went live, for anyone: `version`, `commit`, `live` (newest first: `repo`, `number`, `title`, `at`) and `onItsWay` (landed, not yet in the running commit), the list /changelog shows (the `ui://forge/releases` card), for `repo` (`all` or `owner/name`; absent is the forge's own, as on the page). `{}`: the forge's kept releases newest first: short sha, version, the pull that landed it, when, and for the live one `live: true` and `since`; for whoever may read /releases, others get its refusal; no rollback, a person does that on the page",
  description: "Kept releases, newest first.",
  inputSchema: { type: "object", properties: { shipped: { type: "boolean" }, repo: { type: "string" } } },
  writes: false,
  async run(ctx, user, args) {
    if (args["shipped"] === true) return good(await shippedAnswer(ctx.app, typeof args["repo"] === "string" ? args["repo"] : null));
    // The page's own gate: its refusal, in words.
    const answer = releasesAnswer(ctx.app, user);
    return answer.ok ? good(answer.value) : bad(answer.error, answer.message);
  },
};
