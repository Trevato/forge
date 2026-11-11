import { scopeAllows } from "../../../core/tokens.ts";
import { getAgentByName, isCrew } from "../../../core/agents.ts";
import { canAdmin } from "../../../core/repos.ts";
import { getUserByName } from "../../../core/users.ts";
import { crewAsSeen, addToCrew, removeFromCrew } from "../../../actions/crew.ts";
import { emailVerified } from "../../../core/verify.ts";
import { governorSeen } from "../../../crew/governed.ts";
import { crewOffInPreview } from "../../../crew/preview.ts";
import { setSeatSlots, seatSlotsSaid } from "../../../actions/seat_slots.ts";
import { checkSeatSlots, seatSlotsOf } from "../../../crew/seat_slots.ts";
import { seatsOf } from "../../../crew/seats.ts";
import { weekCard, WEEK_DAYS } from "../../../crew/week_card.ts";
import { ADMIN_WORDS } from "../../../actions/admin_words.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "crew",
  doc: "`{ kind: \"week\" }` (forge admin): `{ days, members[{ username, merged, returned, spentUsd, idle }] }`, the last 7 days per agent; otherwise `{ repo, add?, remove?, dryRun? }`: without `add` or `remove`, the repository's crew as Settings › Crew reads it (`username`, `displayName`, `role`, and `config` for those who may see it) and `seats { auto, mode, seats[{ role, by, does, without?, state }] }`, the three seats and which are empty, `slots[{ role, slots, max, running, waiting, spentUsd, sharePct }]`, how much each may do at once now and today's spend (0 is paused, still on the crew), and `governor { slots, ceiling, held, why }`, the builders the governor allows now and why (`null` while the crew is off or for a reader who cannot write here); `seat` (planner, builder or reviewer) with `slots` (0 to 8, the planner 0 or 1) sets how much that seat may do at once, 0 pausing it, on the trail at once; `add` or `remove` (an agent's username) says what would change, planned first (`dryRun` is true unless `false`); applying is the repository's admin with an admin token, never an agent; refusals are `no_such_agent`, `not_an_agent`, `unverified`",
  description: "List a repository's crew, or add or remove an agent. Plans first; admin token.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      add: { type: "string" },
      remove: { type: "string" },
      seat: { type: "string" },
      kind: { type: "string" },
      slots: { type: "integer" },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    if (args["kind"] !== undefined) {
      if (args["kind"] !== "week") return bad("invalid", "`kind` is `week`");
      if (user.isAdmin !== true) return bad("forbidden", ADMIN_WORDS.scorecard);
      return good({ days: WEEK_DAYS, members: weekCard(ctx.app.db) });
    }
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const { app } = ctx;
    const add = args["add"];
    const remove = args["remove"];
    const seat = args["seat"];
    if (seat !== undefined || args["slots"] !== undefined) {
      if (add !== undefined || remove !== undefined) return bad("invalid", "give `seat` and `slots`, or `add` or `remove`, not both");
      const checked = typeof seat === "string" ? checkSeatSlots(seat, args["slots"]) : undefined;
      if (checked === undefined) return bad("invalid", "`seat` is planner, builder or reviewer and `slots` a whole number from 0 (paused) to 8, the planner 0 or 1");
      if (args["dryRun"] !== undefined && typeof args["dryRun"] !== "boolean") return bad("invalid", "`dryRun` is true or false");
      if (user.kind === "agent") return bad("forbidden", "changing the crew is a person's call, not an agent's");
      if (!canAdmin(app.db, repo, user)) return bad("forbidden", "only an admin of this repository changes its crew");
      const was = seatSlotsOf(app.db, repo).find((p) => p.role === checked.role)!.slots;
      if (args["dryRun"] !== false)
        return good({ seat: checked.role, from: was, to: checked.slots, changes: was !== checked.slots, says: `This is the plan; nothing changed. ${seatSlotsSaid(checked.role, checked.slots)} Send dryRun: false to apply.` });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "changing the crew needs an admin token");
      const done = await setSeatSlots(app, user, repo, checked.role, checked.slots);
      if (!done.ok) return bad("not_found", "no such app or repository (owner/name)");
      return good({ seat: checked.role, from: was, to: checked.slots, changed: was !== checked.slots, says: seatSlotsSaid(checked.role, checked.slots) });
    }
    if (add === undefined && remove === undefined) {
      const seen = crewAsSeen(app, user, repo);
      if (!seen.ok) return bad("not_found", "no such app or repository (owner/name)");
      return {
        ...good({ crew: seen.value, governor: governorSeen(app, user, repo, new Date()) ?? null, seats: seatsOf(app.db, repo, crewOffInPreview()), slots: seatSlotsOf(app.db, repo) }),
        card: { repo: `${repo.ownerName}/${repo.name}` },
      };
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
