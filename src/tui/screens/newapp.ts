/**
 * "New app" in the terminal: say what it does in a sentence and the app is
 * made from it, as the web form's blank-name path makes it —
 * `newAppFromSentence` names it, scaffolds it, starts production and puts the
 * crew on the first issue. When the person is in organizations a second
 * prompt asks who owns it. The scaffold runs under `runAsync`, so no other
 * session waits on it; success lands on the new repository.
 */

import { appLimitWords } from "../../actions/app_limit.ts";
import { NEW_APP_ERRORS, NO_NAME_ERROR, newAppFromSentence } from "../../actions/apps.ts";
import { repositoryLimitMessage } from "../../actions/repos.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import { storageLimitMessage } from "../../core/storage.ts";
import { parseTemplateName } from "../../apps/template_tip.ts";
import { deriveAppName } from "../../web/pages/apps-name.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { later, promptScreen, runAsync } from "./common.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";

/** The words for a refusal: the action's, and the limits' own sentences. */
function refusal(f: Session, code: string, ownerId: string): string {
  if (code === "repository_limit") return `Not made: ${repositoryLimitMessage(f.app, f.user!)}.`;
  if (code === "storage_limit") return `Not made: ${storageLimitMessage(f.app, ownerId)}.`;
  if (code === "app_limit") return appLimitWords(f.app, ownerId);
  return NEW_APP_ERRORS[code] ?? "That app could not be created.";
}

/**
 * `template` (`owner/name`) makes the app a copy of that repository's tip,
 * as `/apps/new?template=` does; the action refuses one the person cannot read.
 */
export function newAppScreen(f: Session, ctx: Ctx, parent: Screen, template?: string): Screen {
  const owners = f.user
    ? [f.user.username, ...listOrgsForUser(f.db, f.user.id).map((o) => o.username)]
    : [];

  const make = (sentence: string, owner: string): void => {
    ctx.toast("Making your app… the crew starts on it next.");
    runAsync(ctx, async () => {
      const made = await newAppFromSentence(f.app, f.user, {
        sentence,
        owner,
        ...(template === undefined ? {} : { template }),
      });
      if (!made.ok) {
        ctx.toast(refusal(f, made.code, f.user!.id), "danger");
        return;
      }
      const url = appsRuntime(f.app)?.urlFor(made.app, "production");
      ctx.toast(
        url === undefined
          ? `${made.repo.name} is an app, but nothing is serving apps on this forge.`
          : `${made.repo.name} is starting at ${url}.`,
        "success",
      );
      ctx.push(repoScreen(f, ctx, local(f, made.repo)));
    });
  };

  return promptScreen(ctx, parent, {
    title: template === undefined ? "New app" : `New app from ${template}`,
    label: "What should it do?",
    placeholder: "a shared shopping list for the flat",
    hint: "One sentence; the app is named from it.",
    onSubmit: (sentence) => {
      if (deriveAppName(sentence) === undefined) return NO_NAME_ERROR;
      if (owners.length < 2) {
        make(sentence, owners[0] ?? "");
        return undefined;
      }
      return later(ctx, () =>
        promptScreen(ctx, parent, {
          title: "Owner",
          label: `Under which owner? ${owners.join(", ")}`,
          value: owners[0]!,
          onSubmit: (owner) => {
            if (!owners.includes(owner)) return `Pick one of: ${owners.join(", ")}.`;
            make(sentence, owner);
            return undefined;
          },
        }),
      );
    },
  });
}

/** Asks which repository to copy, then goes on as "New app" does. */
export function templateAppScreen(f: Session, ctx: Ctx, parent: Screen): Screen {
  return promptScreen(ctx, parent, {
    title: "New app from a template",
    label: "Which repository?",
    placeholder: "owner/name",
    hint: "A repository you can read; its files start the app.",
    onSubmit: (named) => {
      const parsed = parseTemplateName(named);
      if (parsed === undefined) return "Name it owner/name.";
      return later(ctx, () => newAppScreen(f, ctx, parent, `${parsed.owner}/${parsed.name}`));
    },
  });
}
