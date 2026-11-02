/**
 * Templates: the named starting points a new forge's apps may come from, in
 * one list. Plain data in, plain data out; nothing here writes a file. A
 * template is built in (its files are this forge's own code) or, one day,
 * backed by a repository on this forge (`source: "repo"`, `repo`).
 */

import { err, ok, type Result } from "../kernel/result.ts";

export interface Template {
  readonly id: string;
  readonly title: string;
  /** What a forge made from it starts with, as a phrase that reads after the title. */
  readonly says: string;
  readonly source: "builtin" | "repo";
  /** The repository a `repo` template is read from, as `owner/name`. */
  readonly repo?: string;
}

/** Today's behaviour: the forked apps and an optional fresh one, nothing more. */
export const DEFAULT_TEMPLATE = "blank";

// `blank` first: it is the default, and a picker lists it first.
export const TEMPLATES: readonly Template[] = [
  {
    id: DEFAULT_TEMPLATE,
    title: "Blank",
    says: "Only the apps you fork and the fresh one you describe.",
    source: "builtin",
  },
  {
    id: "starter",
    title: "Starter app",
    says: "A server, a page, tests and a forge.json, ready to change.",
    source: "builtin",
  },
];

/** A template id, or one sentence naming the valid ones. */
export function parseTemplate(v: unknown): Result<string, string> {
  if (typeof v === "string" && TEMPLATES.some((t) => t.id === v)) return ok(v);
  const ids = TEMPLATES.map((t) => t.id);
  return err(`template must be ${ids.slice(0, -1).join(", ")} or ${ids[ids.length - 1]}`);
}

/** The title of a template already validated by `parseTemplate`. */
export function templateOf(id: string): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]!;
}

/** What each template is, for a page or an agent to offer. */
export function templatesView(): { templates: readonly Template[]; default: string } {
  return { templates: TEMPLATES, default: DEFAULT_TEMPLATE };
}
