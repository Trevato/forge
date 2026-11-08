import { labelsWithOpen, listLabels } from "../../../core/issues.ts";
import { canWrite } from "../../../core/repos.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { createLabel, deleteLabel, updateLabel } from "../../../actions/repos.ts";
import { LABEL_WORDS } from "../../../actions/label_words.ts";
import { pageRows } from "../page.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "repo_labels",
  doc: "`{ repo, action?, name?, color?, id? }`: list (`list`, the default, paged by `limit` 1–200 and `cursor`, as `{ items, next_cursor }`, each label with `open`, its open issues and pulls, for a writer; a read-only token may), create (`create`, `name`, `color` six hex digits), rename or recolour (`update`, `id`, `name` and/or `color`, as the labels page) or remove (`remove`, `id`) the repository's labels, as `GET`/`POST …/labels` and `PATCH`/`DELETE …/labels/:id`; create, update and remove need an admin token and a repository admin",
  description:
    "Repo labels: list (default), create, update, remove (admin token).",
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
    if (action === "list") {
      // `open` is each label's open count, told to a writer only (sealed items are counted).
      const rows = labelsWithOpen(ctx.app.db, repo.id, canWrite(ctx.app.db, repo, user));
      return pageRows(rows, (l) => l.id, args);
    }
    if (action !== "create" && action !== "update" && action !== "remove")
      return bad("invalid", "action is list, create, update or remove");
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
    if (action === "update") {
      // The page sends both fields; here either may be left out and keeps its value.
      if (args["name"] === undefined && args["color"] === undefined)
        return bad("invalid", "update names a new name, a new color, or both");
      const current = listLabels(ctx.app.db, repo.id).find((l) => l.id === id);
      if (!current) return bad("not_found", LABEL_WORDS.gone);
      const name = args["name"] ?? current.name;
      const color = args["color"] ?? current.color;
      if (typeof name !== "string" || name.length > 64)
        return bad("invalid", "name is one to 64 characters");
      if (typeof color !== "string") return bad("invalid", LABEL_WORDS.shape);
      const updated = updateLabel(ctx.app, user, repo, id, name, color);
      if (!updated.ok)
        return bad(
          updated.error,
          updated.error === "taken"
            ? LABEL_WORDS.taken
            : updated.error === "not_found"
              ? LABEL_WORDS.gone
              : LABEL_WORDS.shape,
        );
      return good({ says: `Label “${updated.value.name}” updated.`, label: updated.value });
    }
    const gone = deleteLabel(ctx.app, user, repo, id);
    return gone.ok
      ? good({ says: "Removed the label.", removed: id })
      : bad("not_found", "no such label, or you are not this repository's admin");
  },
};
