import { pageLimit } from "../../../core/issues.ts";
import { listReposByOwner } from "../../../core/repos.ts";
import { getUserByName, hiddenFrom } from "../../../core/users.ts";
import { paged, publicProfile } from "../../respond.ts";
import { good, bad, badLimit, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "person",
  doc: "`{ username, limit? (1 to 200), cursor? }`: a person's public profile and the repositories you may see, as `GET /api/v1/users/:username` and its `/repos`; a private one you cannot read is never listed",
  description: "A person's profile and repos you may see.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      cursor: { type: "string" },
    },
    required: ["username"],
  },
  writes: false,
  run(ctx, user, args) {
    const { username, limit, cursor } = args;
    if (typeof username !== "string" || username === "" || username.length > 100)
      return bad("invalid", "`username` is 1 to 100 characters");
    const limitRefused = badLimit(limit);
    if (limitRefused) return limitRefused;
    if (cursor !== undefined && typeof cursor !== "string")
      return bad("invalid", "`cursor` is the one a previous answer gave");
    const person = getUserByName(ctx.app.db, username);
    if (!person || hiddenFrom(person, user)) return bad("not_found", "no such person");
    const size = pageLimit(limit as number | undefined);
    const items = listReposByOwner(ctx.app.db, person.username, user, {
      limit: size,
      ...(cursor ? { cursor } : {}),
    });
    return good({
      ...publicProfile(person),
      repos: paged(items, size, (r) => r.id),
    });
  },
};
