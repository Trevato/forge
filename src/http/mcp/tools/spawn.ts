import { spawnDoor } from "../../../spawn/door.ts";
import { FOLLOW_SHORT } from "../../../spawn/follow_words.ts";
import { good, bad, type Tool, APP_ARG, REVEAL_ARG, LINK_KEPT, LINK_REVEALED } from "../shared.ts";

export const tool: Tool = {
  name: "spawn",
  doc: "`{ name, apps?, crew?, template?, dryRun? }`: a child forge, planned first (`dryRun` is true unless `false`); an admin's, and an `ro` token may plan but not make",
  description:
    "Spawn a child forge. Plans first.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
      },
      apps: {
        type: "array",
        items: APP_ARG,
      },
      crew: {
        type: "array",
        items: { type: "string" },
      },
      direction: {
        type: "string",
      },
      fresh: {
        type: "string",
        description: "One line: a new app to start.",
      },
      followMode: {
        type: "string",
        enum: ["tell-me", "take-updates"],
        description: FOLLOW_SHORT,
      },
      size: {
        type: "string",
        enum: ["small", "medium", "large"],
        description: "Recorded only.",
      },
      template: {
        type: "string",
        description: "An id from `templates`.",
      },
      keepAccess: {
        type: "boolean",
        description: "Stay an owner.",
      },
      dryRun: { type: "boolean" },
      reveal: REVEAL_ARG,
    },
    required: ["name"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    // A secret never passes through an agent's conversation.
    if (args["modelKey"] !== undefined || args["modelEndpoint"] !== undefined)
      return bad(
        "invalid",
        "a model key never travels through an agent: send it with POST /api/v1/forges, or add it on the child's Subscriptions page",
      );
    const door = await spawnDoor(ctx, user, args);
    if (door.status >= 400)
      return bad(String(door.body["error"]), String(door.body["message"]));
    const made = door.body["dryRun"] === false;
    const { claimUrl, ...rest } = door.body;
    const reveal = args["reveal"] === true && typeof claimUrl === "string";
    return good({
      says: !made
        ? "This is the plan; nothing was made. Send dryRun: false to spawn."
        : `Spawned ${String(door.body["name"])} at ${String(door.body["url"])}. ${reveal ? LINK_REVEALED : LINK_KEPT}`,
      ...rest,
      ...(reveal ? { claimUrl } : {}),
    });
  },
};
