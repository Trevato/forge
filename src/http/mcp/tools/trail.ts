import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { showProvenance } from "../../../actions/provenance.ts";
import { getProvenance, trailFacts } from "../../../core/provenance.ts";
import { canAdmin } from "../../../core/repos.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "trail",
  doc: "`{ repo, shown?, dryRun? }`: where a migrated repository came from (`provenance`: source, sourceUrl, parents, migratedAt) and whether it is shown; with `shown`, shows or hides the trail — planned first (`dryRun` is true unless `false`), only the repository's admin with an admin token, never an agent. Hiding keeps the record; a hidden one reads `null` to anyone but an admin",
  description:
    "A migrated repository's source and forks; `shown` shows or hides them (admin).",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      shown: { type: "boolean" },
      dryRun: { type: "boolean", description: "false to apply" },
    },
    required: ["repo"],
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const shown = args["shown"];
    if (shown === undefined) {
      const found = getProvenance(ctx.app.db, repo.id);
      // The hidden record is the admin's to read, as on the settings page;
      // to anyone else a hidden trail reads exactly like no trail at all.
      const trail =
        found === undefined || (!found.shown && !canAdmin(ctx.app.db, repo, user))
          ? undefined
          : found;
      return good({
        migrated: trail !== undefined,
        shown: trail?.shown ?? false,
        provenance: trail === undefined ? null : trailFacts(trail),
      });
    }
    if (typeof shown !== "boolean") return bad("invalid", "`shown` is true or false");
    const dryRun = args["dryRun"] !== false;
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "showing or hiding the trail needs an admin token");
    const set = showProvenance(ctx.app, user, repo, shown, dryRun);
    if (!set.ok)
      return set.error === "no_provenance"
        ? bad("no_provenance", FAMILY_WORDS.no_provenance)
        : bad("forbidden", "only an admin of this repository shows or hides its trail");
    return good({
      ...set.value,
      says: dryRun
        ? `This is the plan; nothing changed. It is ${set.value.was ? "shown" : "hidden"} now; send dryRun: false to ${set.value.shown ? "show" : "hide"} it.`
        : set.value.shown
          ? "Where this came from is shown."
          : "Where this came from is hidden; the record is kept.",
    });
  },
};
