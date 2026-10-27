import { listLabels } from "../../../core/issues.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { createLabel, deleteLabel } from "../../../actions/repos.ts";
import { LABEL_WORDS } from "../../../actions/label_words.ts";
import { pageRows } from "../page.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "repo_labels",
  doc: "`{ repo, action?, name?, color?, id? }`: list (`list`, the default, paged by `limit` 1–200 and `cursor`, as `{ items, next_cursor }`; a read-only token may), create (`create`, `name`, `color` six hex digits) or remove (`remove`, `id`) the repository's labels, as `GET`/`POST …/labels` and `DELETE …/labels/:id`; create and remove need an admin token and a repository admin",
  description:
    "Repo labels: list (default), create, remove (admin token).",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      action: { type: "string" },
      name: { type: "string" },
      color: { type: "string" },
      id: { type: "string" },
      limit: { type: "number" },
      cursor: { type: "string" },
    },
    required: ["repo"],
  },
  writes: true,
  // Listing, named or by default, is a read: a read-only token may.
  readsWhen: (args) => args["action"] === undefined || args["action"] === "list",
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const action = args["action"] ?? "list";
    if (action === "list") return pageRows(listLabels(ctx.app.db, repo.id), (l) => l.id, args);
    if (action !== "create" && action !== "remove")
      return bad("invalid", "action is list, create or remove");
    // The API asks for an admin token on both routes; so does this.
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing labels needs an admin token");
    if (action === "create") {
      const name = args["name"];
      const color = args["color"] ?? "6b7280";
      if (typeof name !== "string" || name.trim() === "" || name.length > 64)
        return bad("invalid", "name is one to 64 characters");
      if (typeof color !== "string" || !/^[0-9a-fA-F]{6}$/.test(color))
        return bad("invalid", "color is six hex digits, like 6b7280");
      const made = createLabel(ctx.app, user, repo, name, color);
      if (!made.ok)
        return bad(
          made.error,
          made.error === "taken"
            ? "A label with that name already exists."
            : made.error === "invalid"
              ? LABEL_WORDS.shape
              : "no such app or repository (owner/name)",
        );
      return good({ says: `Created the label ${made.value.name}.`, label: made.value });
    }
    const id = args["id"];
    if (typeof id !== "string" || id === "" || id.length > 64)
      return bad("invalid", "id is the label's id, from list");
    const gone = deleteLabel(ctx.app, user, repo, id);
    return gone.ok
      ? good({ says: "Removed the label.", removed: id })
      : bad("not_found", "no such label, or you are not this repository's admin");
  },
};
