import { holdFileAs, listFileHolds, releaseFileAs } from "../../../actions/file_holds.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { holdPull, releasePull } from "../../../actions/holds.ts";
import { getPull } from "../../../core/pulls.ts";
import { good, bad, type Answer, type Tool, str, APP_ARG, planRepo, isAnswer, type Args } from "../shared.ts";
import type { Ctx } from "../../context.ts";
import type { Repo } from "../../../core/repos.ts";
import type { User } from "../../../core/users.ts";

/** `hold` without a pull: new work on a file (#6522), an admin's. */
function fileHold(ctx: Ctx, user: User, repo: Repo, args: Args): Answer {
  const refused = bad("forbidden", "holding files is for an admin of this app");
  const invalid = bad("invalid", "path is relative, without .., under 300 characters");
  if (args["path"] === undefined) {
    if (args["release"] !== undefined || args["why"] !== undefined)
      return bad("invalid", "release and why need a path; send path, or neither to list");
    const listed = listFileHolds(ctx.app, user, repo);
    if (!listed.ok) return refused;
    return good({
      says: listed.value.length === 0 ? "No file is held." : `${listed.value.length} file(s) held.`,
      holds: listed.value.map((h) => ({ path: h.path, by: h.byName, at: h.at })),
    });
  }
  const path = str(args["path"]);
  const dry = args["dryRun"] !== false;
  const hint = "Nothing changed; send dryRun: false to do it.";
  if (!dry && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
    return bad("forbidden", "holding files needs an admin token");
  if (args["release"] === true) {
    const released = releaseFileAs(ctx.app, user, repo, path, dry);
    if (!released.ok) return released.error === "invalid_path" ? invalid : refused;
    return good({
      says: !released.value ? `${path} is not held.` : dry ? `Would release ${path}. ${hint}` : `Released ${path}.`,
      dryRun: dry,
    });
  }
  const held = holdFileAs(ctx.app, user, repo, path, dry);
  if (!held.ok) return held.error === "invalid_path" ? invalid : refused;
  return good({
    says: dry
      ? `Would hold new work on ${held.value.path}. ${hint}`
      : `Held new work on ${held.value.path}: no build starts on an issue that names it.`,
    hold: { path: held.value.path, by: held.value.byName, at: held.value.at },
    dryRun: dry,
  });
}

export const tool: Tool = {
  name: "hold",
  doc: "`{ app, pull | path, why?, until?, release?, dryRun? }`: hold a pull so no rule reviews or lands it, or let it go; a person who can write, never an agent; or with `path` (no `pull`) hold new work on a file so the picker starts no build whose issue names it, or list the holds and who set each; an admin of the app; plans unless `dryRun: false`",
  description:
    "Hold a pull (`why`) or `release` it; or `path`: hold new work on a file. Neither: list file holds.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      pull: { type: "integer" },
      path: { type: "string", description: "A file: relative, no `..`." },
      why: {
        type: "string",
        description: "Why, one line.",
      },
      until: {
        type: "string",
        enum: ["green"],
        description: "green: released when a check passes.",
      },
      release: {
        type: "boolean",
      },
      dryRun: { type: "boolean" },
    },
    required: ["app"],
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["pull"] === undefined) return fileHold(ctx, user, repo, args);
    const n = args["pull"];
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    if (pull === undefined)
      return bad("no_such_pull", `no pull #${String(n)}`);
    const dry = args["dryRun"] !== false;
    const name = `${repo.ownerName}/${repo.name}#${pull.number}`;
    const hint = "Nothing changed; send dryRun: false to do it.";
    if (args["release"] === true) {
      const released = releasePull(ctx.app, user, repo, pull, dry);
      if (!released.ok)
        return bad(
          released.error,
          "holding and releasing are for a person who can write this app",
        );
      return good({
        says: !released.value
          ? `Nothing holds ${name}.`
          : dry
            ? `Would release ${name}. ${hint}`
            : `Released ${name}. The rules take it from here.`,
        held: dry ? released.value : false,
        dryRun: dry,
      });
    }
    if (args["until"] !== undefined && args["until"] !== "green")
      return bad("bad_until", 'until, when given, is "green"');
    const held = holdPull(
      ctx.app,
      user,
      repo,
      pull,
      str(args["why"]),
      dry,
      args["until"] === "green" ? "green" : undefined,
    );
    if (!held.ok)
      return bad(
        held.error,
        held.error === "not_open"
          ? "only an open pull can be held"
          : held.error === "empty_why" || held.error === "why_too_long"
            ? "say why in one line, at most 200 characters (why)"
            : "holding and releasing are for a person who can write this app",
      );
    return good({
      says: dry
        ? `Would hold ${name}: "${held.value.why}". ${hint}`
        : `Held ${name}. No rule reviews or lands it until it is released.`,
      held: !dry,
      hold: { by: held.value.heldByName, why: held.value.why },
      dryRun: dry,
    });
  },
};
