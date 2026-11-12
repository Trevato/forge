/** An admin marks or unmarks a repository as an app template; everyone else is refused (`forbidden`); an unknown name is `no_such_template`. */

import type { App } from "../app.ts";
import { DEFAULT_TEMPLATE, setTemplateMark } from "../core/app_templates.ts";
import { getRepo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { parseTemplateName } from "../apps/template_tip.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type MarkTemplateError = "forbidden" | "no_such_template" | "default_template";

export const MARK_TEMPLATE_ERRORS: Record<MarkTemplateError, string> = {
  forbidden: "Only a site admin marks app templates.",
  no_such_template: "No repository by that name. Name it owner/name.",
  default_template: `${DEFAULT_TEMPLATE} is always offered first.`,
};

export function markTemplate(
  app: App,
  actor: User | undefined,
  named: string,
  marked: boolean,
): Result<{ name: string; marked: boolean }, MarkTemplateError> {
  if (!actor || !actor.isAdmin || actor.kind !== "user") return err("forbidden");
  const parsed = parseTemplateName(named);
  const repo = parsed && getRepo(app.db, parsed.owner, parsed.name);
  if (!repo) return err("no_such_template");
  const name = `${repo.ownerName}/${repo.name}`;
  if (!marked && name === DEFAULT_TEMPLATE) return err("default_template");
  setTemplateMark(app.db, repo, marked, actor.id);
  app.bus.append({
    kind: marked ? "app_template.marked" : "app_template.unmarked",
    actorId: actor.id,
    payload: { repo: name },
  });
  return ok({ name, marked });
}
