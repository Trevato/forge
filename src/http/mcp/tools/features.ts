import { absorbApp, changeFeatureSettings, getFeature, listFeatures, unabsorbApp } from "../../../actions/features.ts";
import { callFeatureTool } from "../../../actions/feature_tools.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "features",
  doc: "`{ slug?, absorb?, settings?, tool?, args?, dryRun? }`: apps absorbed as the forge's own features. With nothing, every app whose forge.json declares a `feature`, absorbed or not (forge admin); with `slug`, that one and its typed settings (its readers); `absorb: true|false` absorbs or un-absorbs it, `settings: { name: value }` changes an absorbed one's settings (each checked against its declaration, the app restarts with them as `FORGE_SETTING_*`); `tool` calls one of the absorbed app's declared tools (listed as `tools` with `slug`) with `args`: a read tool answers at once, one that writes is for a repo writer and planned first; absorbing and settings changes are planned first (`dryRun` is true unless `false`) and need an admin-scope token",
  description: "Apps absorbed as forge features: list, read, absorb or un-absorb, change typed settings.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", maxLength: 100 },
      absorb: { type: "boolean" },
      settings: { type: "object" },
      tool: { type: "string", maxLength: 40 },
      args: { type: "object" },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const slug = typeof args["slug"] === "string" ? args["slug"] : undefined;
    if (slug === undefined) {
      const listed = await listFeatures(ctx.app, user);
      return listed.ok ? good({ items: listed.value }) : bad("not_found", "no such tool here");
    }
    const found = await getFeature(ctx.app, user, slug);
    if (!found.ok) return bad(found.error, found.error === "not_a_feature" ? "that app declares no feature" : "no such app");
    const tool = typeof args["tool"] === "string" ? args["tool"] : undefined;
    if (tool !== undefined) {
      const spec = found.value.tools.find((t) => t.name === tool);
      const given = typeof args["args"] === "object" && args["args"] !== null && !Array.isArray(args["args"]) ? (args["args"] as Record<string, unknown>) : {};
      if (spec?.writes === true && !scopeAllows(ctx.auth.scope ?? "ro", "rw")) return bad("forbidden", "a tool that writes needs an rw token");
      const called = await callFeatureTool(ctx.app, user, slug, tool, given, args["dryRun"] !== false);
      if (!called.ok) return bad(called.error.error, called.error.message);
      return good("planned" in called.value ? { says: called.value.planned } : { tool, result: called.value.answer });
    }
    const absorb = typeof args["absorb"] === "boolean" ? args["absorb"] : undefined;
    const settings = typeof args["settings"] === "object" && args["settings"] !== null && !Array.isArray(args["settings"])
      ? (args["settings"] as Record<string, unknown>)
      : undefined;
    if (absorb === undefined && settings === undefined) return good(found.value);
    if (args["dryRun"] !== false) {
      const would = [
        absorb === undefined ? "" : absorb ? `absorb ${found.value.name}` : `un-absorb ${found.value.name}`,
        settings === undefined ? "" : `set ${Object.keys(settings).join(", ")} on ${found.value.name} and restart it`,
      ].filter(Boolean);
      return good({ says: `Would ${would.join(", then ")}. Send dryRun: false to do it.` });
    }
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "absorbing an app or changing its settings needs an admin-scope token");
    if (absorb !== undefined) {
      const done = absorb ? await absorbApp(ctx.app, user, slug) : await unabsorbApp(ctx.app, user, slug);
      if (!done.ok) return bad(done.error, done.error === "not_absorbed" ? "that app is not absorbed" : "only a site admin absorbs apps");
      if (settings === undefined) return good(done.value);
    }
    const changed = await changeFeatureSettings(ctx.app, user, slug, settings ?? {});
    return changed.ok ? good(changed.value) : bad(changed.error.error, changed.error.message);
  },
};
