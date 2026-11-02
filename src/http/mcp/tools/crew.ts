import { scopeAllows } from "../../../core/tokens.ts";
import { getAgentByName, isCrew } from "../../../core/agents.ts";
import { canAdmin } from "../../../core/repos.ts";
import { getUserByName } from "../../../core/users.ts";
import { crewAsSeen, addToCrew, removeFromCrew } from "../../../actions/crew.ts";
import { emailVerified } from "../../../core/verify.ts";
import { governorSeen } from "../../../crew/governed.ts";
import { crewOffInPreview } from "../../../crew/preview.ts";
import { seatsOf } from "../../../crew/seats.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "crew",
  doc: "`{ repo, add?, remove?, dryRun? }`: without `add` or `remove`, the repository's crew as Settings › Crew reads it (`username`, `displayName`, `role`, and `config` for those who may see it) and `seats { auto, mode, seats[{ role, by, does, without?, state }] }`, the three seats and which are empty, and `governor { slots, ceiling, held, why }`, the builders the governor allows now and why (`null` while the crew is off or for a reader who cannot write here); `add` or `remove` (an agent's username) says what would change, planned first (`dryRun` is true unless `false`); applying is the repository's admin with an admin token, never an agent; refusals are `no_such_agent`, `not_an_agent`, `unverified`",
  description: "List a repository's crew, or add or remove an agent. Plans first; admin token.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      add: { type: "string" },
      remove: { type: "string" },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const { app } = ctx;
    const add = args["add"];
    const remove = args["remove"];
    if (add === undefined && remove === undefined) {
      const seen = crewAsSeen(app, user, repo);
      if (!seen.ok) return bad("not_found", "no such app or repository (owner/name)");
      return good({ crew: seen.value, governor: governorSeen(app, user, repo, new Date()) ?? null, seats: seatsOf(app.db, repo, crewOffInPreview()) });
    }
    if ((add !== undefined && typeof add !== "string") || (remove !== undefined && typeof remove !== "string"))
      return bad("invalid", "`add` and `remove` are an agent's username");
    if (add !== undefined && remove !== undefined)
      return bad("invalid", "give `add` or `remove`, not both");
    if (args["dryRun"] !== undefined && typeof args["dryRun"] !== "boolean")
      return bad("invalid", "`dryRun` is true or false");
    const dryRun = args["dryRun"] !== false;
    if (user.kind === "agent")
      return bad("forbidden", "changing the crew is a person's call, not an agent's");
    if (!canAdmin(app.db, repo, user))
      return bad("forbidden", "only an admin of this repository changes its crew");
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing the crew needs an admin token");

    const adding = add !== undefined;
    const name = (adding ? add : remove) as string;
    const agent = getAgentByName(app.db, name);
    if (!agent) {
      const code = adding && getUserByName(app.db, name) ? "not_an_agent" : "no_such_agent";
      return bad(
        code,
        code === "not_an_agent"
          ? `${name} is a person, and only an agent is on a crew`
          : `no agent is named ${name}`,
      );
    }
    if (adding && !emailVerified(app.db, user.id))
      return bad("unverified", "verify your email first");
    const on = isCrew(app.db, repo.id, agent.user.id);
    const changes = adding ? !on : on;
    if (dryRun)
      return good({
        agent: name,
        changes,
        says: changes
          ? `This is the plan; nothing changed. ${name} ${adding ? "would join" : "would leave"} the crew; send dryRun: false to apply.`
          : `This is the plan; nothing changed. ${name} is ${adding ? "already" : "not"} on the crew.`,
      });
    const done = adding ? addToCrew(app, user, repo, name) : removeFromCrew(app, user, repo, name);
    if (!done.ok) return bad(done.error, `could not change the crew: ${done.error}`);
    return good({
      agent: name,
      changed: changes,
      says: changes ? `${name} ${adding ? "is on" : "is off"} the crew.` : `${name} was ${adding ? "already" : "not"} on the crew.`,
    });
  },
};
