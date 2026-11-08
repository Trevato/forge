import { appsRuntime } from "../../../apps/runtime.ts";
import { previewOf } from "../../../apps/preview_view.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "preview",
  doc: "`{ url }`: what the forge pill says of an app host's URL (production or a pull's preview): `{ app, environment, pull: { number, title } \\| null, check: \"green\" \\| \"red\" \\| \"running\" \\| null, firstFailure, logUrl, working: [names], serving: { state: \"running\" \\| \"starting\" \\| \"failed\" \\| \"not_running\" \\| \"gone\", says, runUrl } }`; `firstFailure` is the check's first failing test or its summary, `logUrl` is set only for someone who may read the log (a writer), `working` names the agents with a run going, `serving.says` is the sentence the not-serving page shows (a failure's error redacted), `runUrl` the run it links; an open pull is never `gone`; a URL that is not one of this forge's app hosts is `invalid`, an app you cannot read is `not_found` and a pull you cannot see is `no_such_pull`, as `repo` and `pull` say",
  description:
    "An app URL's pull, check, first failure, log.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  writes: false,
  run(ctx, user, args) {
    const seen = previewOf(ctx.app, appsRuntime(ctx.app)?.options.domain, user, ctx.url.origin, args["url"]);
    if (seen.ok) return good(seen.value);
    if (seen.error === "foreign") return bad("invalid", "`url` is one of this forge's app hosts");
    if (seen.error === "no_such_pull") return bad("no_such_pull", `no pull #${String(seen.number)}`);
    return bad("not_found", "no such app or repository (owner/name)");
  },
};
