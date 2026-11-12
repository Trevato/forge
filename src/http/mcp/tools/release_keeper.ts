import { mayRead } from "../../../release/gate.ts";
import { keeperAnswer } from "../../../keeper/landed.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "release_keeper",
  doc: "`{}`: what the release keeper (#7557) did: its releases newest first (version, commit (short sha), stage — rolling, verifying, verified or rolled_back —, the known-good version it would roll back to, roll probes and non-200s, probes and pages under load, worst ms, seconds dark, reason, landedToLiveSeconds — from the merge of its pull to the new version answering, null until it has (#8042)) and its holds (kind failed or owner, version, reason, probe numbers, the pull that said `release hold N`, lifted); `blocked` says what stops the next cut; `heartbeat` is the release tick's last report (at, outcome cut/skipped/failed, reason, silent when over an hour old, #11507); for whoever may read /releases",
  description: "The release keeper's releases, holds and what blocks the next cut.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    if (!mayRead(ctx.app, user))
      return bad("forbidden", "the release history is for the forge's administrators and its repository's readers");
    return good(keeperAnswer(ctx.app.db));
  },
};
