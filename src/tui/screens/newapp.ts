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

export function newAppScreen(f: Session, ctx: Ctx, parent: Screen): Screen {
  const owners = f.user
    ? [f.user.username, ...listOrgsForUser(f.db, f.user.id).map((o) => o.username)]
    : [];

  const make = (sentence: string, owner: string): void => {
    ctx.toast("Making your app… the crew starts on it next.");
    runAsync(ctx, async () => {
      const made = await newAppFromSentence(f.app, f.user, { sentence, owner });
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
    title: "New app",
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
